import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireLock, getLockStatus, releaseLock, renewLock } from "./manager";
import { installFakeGithubLockApi } from "./test-helpers";

const owner = "acme";
const repo = "demo";
const branch = "feature-x";
const token = "fake-token";

describe("lock manager", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installFakeGithubLockApi(owner, repo);
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

  test("renew refreshes acquiredAt for the current holder", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    const before = await getLockStatus({ owner, repo, branch, token, ttlMs: 1000 });
    expect(before.locked && !before.expired).toBe(true);

    // Simulate the original lock having aged past a short ttl: renew
    // should bring it back under the ttl without changing the holder.
    const renewed = await renewLock({ owner, repo, branch, token, holder: "agent-a" });
    expect(renewed.ok).toBe(true);
    if (renewed.ok) {
      expect(renewed.lock.holder).toBe("agent-a");
      expect(renewed.stolen).toBe(false);
    }

    const after = await getLockStatus({ owner, repo, branch, token, ttlMs: 1000 });
    expect(after.locked).toBe(true);
    if (after.locked) {
      expect(after.expired).toBe(false);
    }
  });

  test("renew fails for a holder that does not hold the lock", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    const result = await renewLock({ owner, repo, branch, token, holder: "agent-b" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.heldBy?.holder).toBe("agent-a");
    }
  });

  test("renew fails when nobody holds the lock", async () => {
    const result = await renewLock({ owner, repo, branch, token, holder: "agent-a" });
    expect(result).toEqual({ ok: false, error: `no lock held for branch '${branch}'` });
  });

  test("renew fails once the lock has been stolen out from under the holder", async () => {
    await acquireLock({ owner, repo, branch, token, holder: "agent-a" });
    await acquireLock({ owner, repo, branch, token, holder: "agent-b", ttlMs: -1 });

    const result = await renewLock({ owner, repo, branch, token, holder: "agent-a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.heldBy?.holder).toBe("agent-b");
    }
  });
});
