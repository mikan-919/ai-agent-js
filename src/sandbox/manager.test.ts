import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { installFakeGithubLockApi } from "../lock/test-helpers";
import { createSandbox, destroySandbox } from "./manager";

const owner = "acme";
const repo = "demo";
const token = "fake-token";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with code ${exitCode}`);
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nook-sandbox-repo-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  await git(dir, ["remote", "add", "origin", `git@github.com:${owner}/${repo}.git`]);
  return dir;
}

describe("sandbox manager", () => {
  let restoreGithub: () => void;
  let repoPath: string;
  let baseDir: string;

  beforeEach(async () => {
    restoreGithub = installFakeGithubLockApi(owner, repo);
    repoPath = await initRepo();
    baseDir = await mkdtemp(join(tmpdir(), "nook-sandbox-base-"));
  });

  afterEach(async () => {
    restoreGithub();
    await rm(repoPath, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  test("creates a worktree for a brand-new branch and acquires the lock", async () => {
    const result = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", baseDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sandbox.resumed).toBe(false);
    expect(result.sandbox.holder).toBe("agent-a");

    const checkedOutBranch = (await $`git -C ${result.sandbox.path} rev-parse --abbrev-ref HEAD`.text()).trim();
    expect(checkedOutBranch).toBe("feature-x");
  });

  test("a second holder is rejected while the sandbox's lock is held", async () => {
    await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", baseDir });
    const result = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-b", baseDir });
    expect(result.ok).toBe(false);
  });

  test("resuming with the same holder reuses the existing worktree", async () => {
    const first = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", baseDir });
    const second = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", baseDir });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.sandbox.resumed).toBe(true);
    expect(second.sandbox.path).toBe(first.sandbox.path);
  });

  test("destroySandbox removes the worktree and releases the lock for the next holder", async () => {
    const created = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", baseDir });
    expect(created.ok).toBe(true);

    const destroyed = await destroySandbox({ repoPath, branch: "feature-x", token, baseDir });
    expect(destroyed.ok).toBe(true);

    const reacquired = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-b", baseDir });
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) {
      expect(reacquired.sandbox.resumed).toBe(false);
    }
  });

  test("returns ok:false instead of throwing when the lock API fails unexpectedly", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    try {
      const result = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", baseDir });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("network unreachable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("builds the worktree from an existing remote-tracking branch when the local branch is missing", async () => {
    await git(repoPath, ["branch", "feature-y"]);
    await git(repoPath, ["update-ref", "refs/remotes/origin/feature-y", "refs/heads/feature-y"]);
    await git(repoPath, ["branch", "-D", "feature-y"]);

    const result = await createSandbox({ repoPath, branch: "feature-y", token, holder: "agent-a", baseDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const checkedOutBranch = (await $`git -C ${result.sandbox.path} rev-parse --abbrev-ref HEAD`.text()).trim();
    expect(checkedOutBranch).toBe("feature-y");
  });
});
