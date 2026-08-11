import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMainBranch, resolveGitContext, resolveRef } from "./git";

const dirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with code ${exitCode}`);
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-git-context-"));
  dirs.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  return dir;
}

/**
 * Mirrors a shallow/single-branch CI checkout: `main` only exists as a
 * remote-tracking ref, the repo is actually checked out on some other local
 * branch, and there is no `refs/heads/main` anywhere in the repo.
 */
async function initRepoWithoutLocalMain(): Promise<string> {
  const dir = await initRepo();
  await git(dir, ["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  await git(dir, ["checkout", "-q", "-b", "work"]);
  await git(dir, ["branch", "-D", "main"]);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("detectMainBranch", () => {
  test("returns the bare name when a local main branch exists", async () => {
    const dir = await initRepo();
    expect(await detectMainBranch(dir)).toBe("main");
  });

  test("returns the bare name, not an origin/-prefixed ref, when only the remote-tracking branch exists", async () => {
    const dir = await initRepoWithoutLocalMain();
    expect(await detectMainBranch(dir)).toBe("main");
  });
});

describe("resolveRef", () => {
  test("prefers the local branch when it exists", async () => {
    const dir = await initRepo();
    expect(await resolveRef(dir, "main")).toBe("main");
  });

  test("falls back to the remote-tracking ref when the local branch is missing", async () => {
    const dir = await initRepoWithoutLocalMain();
    expect(await resolveRef(dir, "main")).toBe("origin/main");
    expect(await resolveRef(dir, "work")).toBe("work");
  });

  test("throws when neither the local nor the remote-tracking ref exists", async () => {
    const dir = await initRepo();
    await expect(resolveRef(dir, "nonexistent")).rejects.toThrow("could not resolve ref");
  });
});

describe("resolveGitContext", () => {
  test("reports a bare main branch name even when only origin/main exists, and still diffs correctly", async () => {
    const dir = await initRepoWithoutLocalMain();
    const ctx = await resolveGitContext(dir);

    expect(ctx.branch).toBe("work");
    // The regression this guards against: mainBranch used to come back as
    // "origin/main" here, which breaks both the GitHub PR "base" field and
    // docsTools' push-to-main guard (both expect a bare branch name).
    expect(ctx.mainBranch).toBe("main");
    expect(ctx.diff.filesChanged).toBe(0);
  });
});
