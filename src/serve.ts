import { Hono } from "hono";
import { resolveWorkContext } from "./context";

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

  return app;
}
