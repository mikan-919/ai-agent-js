import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { runAgent } from "./agent";
import { createPullRequestTool } from "./agent/pullRequest";
import { createSandboxTools } from "./agent/sandboxTools";
import type { AgentSession } from "./agent/session";
import { createSession } from "./agent/session";
import { buildSystemPrompt } from "./agent/systemPrompt";
import type { PullRequestOutcome, RunAgentResult } from "./agent/types";
import { resolveWorkContext } from "./context";
import { createSandbox, destroySandbox } from "./sandbox";

const DEFAULT_CHAT_SESSION_IDLE_MS = 30 * 60 * 1000;
/** How often the idle sweep checks chatSessions for eviction candidates. */
const CHAT_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function resolveChatSessionIdleMs(): number {
  const raw = process.env.NOOK_CHAT_SESSION_IDLE_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAT_SESSION_IDLE_MS;
}

/**
 * The server is fixed to the repo path (and whatever branch is currently
 * checked out there) it was started with. There is no per-request
 * repo/branch switching in v1 — resolveWorkContext is still called fresh on
 * every request, so it reflects live state of that one working tree.
 */
export function createServer(repoPath: string) {
  const app = new Hono();

  /**
   * Chat's live sessions, one per branch, kept in server memory for as long
   * as the process runs. This is deliberately different from POST
   * /agent/run: that endpoint is one-shot (a trigger firing a single
   * task, not an ongoing conversation), so it still creates a session, sends
   * once, and closes it. Chat is a back-and-forth conversation with the same
   * human, so re-doing a full "resume" (transcript reload + summarization
   * LLM call) on every single message — which is what calling runAgent
   * fresh per message used to do — was pure waste. A session's *first* turn
   * still pays that cost if the sandbox has a leftover transcript from a
   * previous process (see session.ts); every turn after that, for as long as
   * this session stays in memory, is a plain agent.prompt() call. The
   * transcript is still persisted to disk after every send (cheap — no LLM
   * call involved), so a server crash loses at most the in-flight turn, not
   * the conversation: CONCEPT.md principle 1 still holds because disk stays
   * the durable source of truth, this map is just a warm cache while alive.
   */
  interface ChatSessionEntry {
    session: AgentSession;
    pullRequestRef: { current: PullRequestOutcome | null };
    lastActivityAt: number;
  }
  const chatSessions = new Map<string, ChatSessionEntry>();

  async function getOrCreateChatSession(branch: string, token: string) {
    const existing = chatSessions.get(branch);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return { ok: true as const, entry: existing };
    }

    const pullRequestRef: { current: PullRequestOutcome | null } = { current: null };
    const result = await createSession({
      repoPath,
      branch,
      token,
      createTools: (ctx) => [
        ...createSandboxTools(ctx.sandboxPath),
        createPullRequestTool({
          cwd: ctx.sandboxPath,
          owner: ctx.owner,
          repo: ctx.repo,
          branch: ctx.branch,
          baseBranch: ctx.baseBranch,
          token: ctx.token,
          onResult: (outcome) => {
            pullRequestRef.current = outcome;
          },
        }),
      ],
      buildSystemPrompt: ({ workContext, previousSessionSummary }) => buildSystemPrompt(workContext, { previousSessionSummary }),
    });
    if (!result.ok) return result;

    const entry = { session: result.session, pullRequestRef, lastActivityAt: Date.now() };
    chatSessions.set(branch, entry);
    return { ok: true as const, entry };
  }

  /**
   * Removes a branch's live chat session, if any, persisting its transcript
   * one last time first (AgentSession.close). Called both when the sandbox
   * backing it is explicitly destroyed and by the idle sweep below — the two
   * are the same cleanup, just triggered differently, so this is the one
   * place that does it (CONCEPT.md principle 3: don't duplicate).
   */
  async function evictChatSession(branch: string): Promise<void> {
    const entry = chatSessions.get(branch);
    if (!entry) return;
    chatSessions.delete(branch);
    await entry.session.close().catch(() => {});
  }

  /**
   * Frees sessions nobody has talked to in a while so a long-running `nook
   * serve` doesn't accumulate one live Agent per branch forever (ROADMAP.md
   * unresolved issue 6). This only evicts the in-memory session — the
   * sandbox and its lock are untouched and outlive it, same as they already
   * do for runAgent's one-shot sessions; the next chat message on that
   * branch just pays the cold-start (resume + summarize) cost again.
   */
  const sweepInterval = setInterval(() => {
    const idleMs = resolveChatSessionIdleMs();
    const now = Date.now();
    for (const [branch, entry] of chatSessions) {
      if (now - entry.lastActivityAt >= idleMs) {
        void evictChatSession(branch);
      }
    }
  }, CHAT_SESSION_SWEEP_INTERVAL_MS);
  sweepInterval.unref();

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
    const sandboxResult = await createSandbox({ repoPath, branch, token });
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
   * The web UI's chat endpoint: unlike POST /agent/run, this reuses one live
   * session per branch across every message (see chatSessions above) instead
   * of starting a fresh one per request. Every AgentEvent is forwarded to
   * the client as it happens; the turn's final result (summary, pull
   * request, or error) is sent as one last "run_end" SSE event, in the same
   * RunAgentResult shape POST /agent/run/stream always returned, since
   * agent_end alone doesn't carry those — the frontend doesn't need to know
   * this moved to a session underneath.
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
      const sessionResult = await getOrCreateChatSession(branch, token).catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));

      if (!sessionResult.ok) {
        const result: RunAgentResult = { ok: false, error: sessionResult.error };
        await stream.writeSSE({ event: "run_end", data: JSON.stringify(result) });
        return;
      }

      const { entry } = sessionResult;
      entry.pullRequestRef.current = null;

      const sendResult = await entry.session.send(prompt, (event) => {
        void stream.writeSSE({ event: "agent", data: JSON.stringify(event) });
      });
      entry.lastActivityAt = Date.now();

      const result: RunAgentResult = sendResult.ok
        ? {
            ok: true,
            summary: sendResult.summary ?? "",
            pullRequest: entry.pullRequestRef.current,
            sandboxPath: entry.session.sandboxPath,
            resumed: entry.session.resumed,
          }
        : { ok: false, error: sendResult.error ?? "unknown error", timedOut: sendResult.timedOut };

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
    if (result.ok) await evictChatSession(branch);
    return c.json(result, result.ok ? 200 : 409);
  });

  // The web UI's static build (React + Tailwind, see web/ and
  // scripts/build-web.ts). Mounted last so it never shadows an API route;
  // `bun run build:web` must be run at least once before this has anything
  // to serve.
  app.get("/*", serveStatic({ root: "./dist/web" }));

  return app;
}
