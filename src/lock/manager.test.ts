import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireLock, getLockStatus, releaseLock } from "./manager";

const owner = "acme";
const repo = "demo";
const branch = "feature-x";
const token = "fake-token";

/**
 * Stands in for the slice of the GitHub REST API the lock manager touches.
 * Ref creation is the only op that matters for correctness: it is
 * implemented as a synchronous Map check-and-set, mirroring GitHub's
 * atomic "fails if the ref already exists" behavior.
 */
function installFakeGithub() {
  const refs = new Map<string, string>();
  const commits = new Map<string, { message: string; committerDate: string }>();
  let shaCounter = 0;

  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const json = (status: number, body: unknown) =>
    new Response(body === null ? null : JSON.stringify(body), { status });

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(base)) throw new Error(`unexpected fetch to ${url}`);
    const path = url.slice(base.length);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && /^\/commits\/[^/]+$/.test(path)) {
      return json(200, { sha: "branch-head-sha", commit: { tree: { sha: "branch-tree-sha" } } });
    }

    if (method === "POST" && path === "/git/commits") {
      const body = JSON.parse(String(init?.body));
      const sha = `commit-${++shaCounter}`;
      commits.set(sha, { message: body.message, committerDate: body.committer.date });
      return json(201, { sha });
    }

    if (method === "POST" && path === "/git/refs") {
      const body = JSON.parse(String(init?.body));
      const refKey = body.ref.replace(/^refs\//, "");
      if (refs.has(refKey)) return json(422, { message: "Reference already exists" });
      refs.set(refKey, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }

    const getRefMatch = path.match(/^\/git\/ref\/(.+)$/);
    if (method === "GET" && getRefMatch) {
      const sha = refs.get(getRefMatch[1]!);
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }

    const deleteRefMatch = path.match(/^\/git\/refs\/(.+)$/);
    if (method === "DELETE" && deleteRefMatch) {
      const refKey = deleteRefMatch[1]!;
      if (!refs.has(refKey)) return json(404, { message: "Not Found" });
      refs.delete(refKey);
      return json(204, null);
    }

    const getCommitMatch = path.match(/^\/git\/commits\/([^/]+)$/);
    if (method === "GET" && getCommitMatch) {
      const commit = commits.get(getCommitMatch[1]!);
      return commit
        ? json(200, { message: commit.message, committer: { date: commit.committerDate } })
        : json(404, { message: "Not Found" });
    }

    throw new Error(`unhandled fake GitHub request: ${method} ${path}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

describe("lock manager", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installFakeGithub();
  });
  afterEach(() => restore());

  test("acquires a free lock", async () => {
    const result = await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stolen).toBe(false);
      expect(result.lock.holder).toBe("agent-a");
    }
  });

  test("status reflects an acquired lock", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    const status = await getLockStatus({ owner, repo, branch, token });
    expect(status.locked).toBe(true);
    if (status.locked) {
      expect(status.lock.holder).toBe("agent-a");
      expect(status.expired).toBe(false);
    }
  });

  test("status reports unlocked when no ref exists", async () => {
    const status = await getLockStatus({ owner, repo, branch, token });
    expect(status).toEqual({ locked: false });
  });

  test("a second holder is rejected while the lock is fresh", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    const result = await acquireLock({ owner, repo, branch, token, holder: "agent-b" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.heldBy?.holder).toBe("agent-a");
    }
  });

  test("release frees the lock for the next holder", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    const released = await releaseLock({ owner, repo, branch, token });
    expect(released.ok).toBe(true);

    const status = await getLockStatus({ owner, repo, branch, token });
    expect(status).toEqual({ locked: false });

    const reacquired = await acquireLock({ owner, repo, branch, token, holder: "agent-b" });
    expect(reacquired.ok).toBe(true);
  });

  test("releasing a lock nobody holds fails", async () => {
    const result = await releaseLock({ owner, repo, branch, token });
    expect(result).toEqual({ ok: false, error: `no lock held for branch '${branch}'` });
  });

  test("an expired lock is stolen instead of blocking", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    // Negative ttlMs treats any held lock as already past its TTL.
    const result = await acquireLock({ owner, repo, branch, token, holder: "agent-b", ttlMs: -1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stolen).toBe(true);
      expect(result.lock.holder).toBe("agent-b");
    }
  });

  test("concurrent steals of an expired lock resolve to exactly one winner", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });

    const [first, second] = await Promise.all([
      acquireLock({ owner, repo, branch, token, holder: "agent-b", ttlMs: -1 }),
      acquireLock({ owner, repo, branch, token, holder: "agent-c", ttlMs: -1 }),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0]!;
    if (!winner.ok) throw new Error("unreachable: filtered for ok results");

    const status = await getLockStatus({ owner, repo, branch, token });
    expect(status.locked).toBe(true);
    if (status.locked) {
      expect(status.lock.holder).toBe(winner.lock.holder);
    }
  });
});
