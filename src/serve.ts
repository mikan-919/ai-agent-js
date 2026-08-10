import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { runAgent } from "./agent";
import { resolveWorkContext } from "./context";
import { createSandbox, destroySandbox } from "./sandbox";

/**
 * The server is fixed to the repo path (and whatever branch is currently
 * checked out there) it was started with. There is no per-request
 * repo/branch switching in v1 — resolveWorkContext is still called fresh on
 * every request, so it reflects live state of that one working tree.
 */
export function createServer(repoPath: string) {
  const app = new Hono();

  app.get("/work-context", async (c) => {
    const workContext = await resolveWorkContext(repoPath);
    return c.json(workContext);
  });

  /**
   * Per-branch view for the web UI: work context as it looks from inside
   * that branch's sandbox (created/resumed on demand), not the server's own
   * checked-out branch. Reuses createSandbox rather than inventing a
   * read-only lookup, so viewing a branch and starting a chat on it go
   * through the same sandbox/lock lifecycle (CONCEPT.md principle 1 — no
   * separate read-path state).
   */
  app.get("/work-context/:branch", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const branch = c.req.param("branch");
    let sandboxResult: Awaited<ReturnType<typeof createSandbox>>;
    try {
      sandboxResult = await createSandbox({ repoPath, branch, token });
    } catch (error) {
      // createSandbox's own try/catch doesn't cover its lock-status check
      // (a GitHub API failure there throws rather than returning
      // { ok: false }) — caught here so a transient GitHub error surfaces as
      // JSON instead of crashing the response.
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
    }
    if (!sandboxResult.ok) return c.json({ ok: false, error: sandboxResult.error }, 409);

    const workContext = await resolveWorkContext(sandboxResult.sandbox.path);
    return c.json({ ok: true, workContext, resumed: sandboxResult.sandbox.resumed });
  });

  app.post("/sandbox", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const body = await c.req.json().catch(() => ({}));
    const branch = body.branch;
    if (typeof branch !== "string" || branch.length === 0) {
      return c.json({ ok: false, error: "branch is required" }, 400);
    }

    const backend = body.backend === "docker" ? "docker" : undefined;

    const result = await createSandbox({
      repoPath,
      branch,
      token,
      holder: typeof body.holder === "string" ? body.holder : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      backend,
      image: typeof body.image === "string" ? body.image : undefined,
    });
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post("/agent/run", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const body = await c.req.json().catch(() => ({}));
    const branch = body.branch;
    if (typeof branch !== "string" || branch.length === 0) {
      return c.json({ ok: false, error: "branch is required" }, 400);
    }
    const prompt = body.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      return c.json({ ok: false, error: "prompt is required" }, 400);
    }

    const result = await runAgent({ repoPath, branch, prompt, token });
    if (result.ok) return c.json(result, 200);
    return c.json(result, result.timedOut ? 504 : 502);
  });

  /**
   * Streaming twin of POST /agent/run for the web UI's chat: same runAgent
   * call (same sandbox/resume/transcript-summary behavior), but every
   * AgentEvent is forwarded to the client as it happens instead of waiting
   * for the whole run to finish. The run's final RunAgentResult (summary,
   * pull request, or error) is sent as one last "run_end" SSE event since
   * agent_end alone doesn't carry those.
   */
  app.post("/agent/run/stream", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const body = await c.req.json().catch(() => ({}));
    const branch = body.branch;
    if (typeof branch !== "string" || branch.length === 0) {
      return c.json({ ok: false, error: "branch is required" }, 400);
    }
    const prompt = body.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      return c.json({ ok: false, error: "prompt is required" }, 400);
    }

    return streamSSE(c, async (stream) => {
      const result = await runAgent({
        repoPath,
        branch,
        prompt,
        token,
        onEvent: (event) => {
          void stream.writeSSE({ event: "agent", data: JSON.stringify(event) });
        },
      }).catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));

      await stream.writeSSE({ event: "run_end", data: JSON.stringify(result) });
    });
  });

  app.delete("/sandbox/:branch", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const branch = c.req.param("branch");
    const force = c.req.query("force") === "true";
    const backend = c.req.query("backend") === "docker" ? "docker" : undefined;
    const result = await destroySandbox({ repoPath, branch, token, force, backend });
    return c.json(result, result.ok ? 200 : 409);
  });

  // The web UI's static build (React + Tailwind, see web/ and
  // scripts/build-web.ts). Mounted last so it never shadows an API route;
  // `bun run build:web` must be run at least once before this has anything
  // to serve.
  app.get("/*", serveStatic({ root: "./dist/web" }));

  return app;
}
