import { Hono } from "hono";
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

  app.post("/sandbox", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const body = await c.req.json().catch(() => ({}));
    const branch = body.branch;
    if (typeof branch !== "string" || branch.length === 0) {
      return c.json({ ok: false, error: "branch is required" }, 400);
    }

    const result = await createSandbox({
      repoPath,
      branch,
      token,
      holder: typeof body.holder === "string" ? body.holder : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
    });
    return c.json(result, result.ok ? 200 : 409);
  });

  app.delete("/sandbox/:branch", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "GITHUB_TOKEN not set" }, 503);

    const branch = c.req.param("branch");
    const force = c.req.query("force") === "true";
    const result = await destroySandbox({ repoPath, branch, token, force });
    return c.json(result, result.ok ? 200 : 409);
  });

  return app;
}
