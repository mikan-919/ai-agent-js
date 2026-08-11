import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { resolveGitContext } from "../context/git";
import { installFakeGithubLockApi } from "../lock/test-helpers";
import { createSandbox, destroySandbox } from "./manager";

const owner = "acme";
const repo = "demo";
const token = "fake-token";
const image = "alpine/git:latest";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with code ${exitCode}`);
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nook-docker-sandbox-repo-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  await git(dir, ["remote", "add", "origin", `git@github.com:${owner}/${repo}.git`]);
  return dir;
}

async function dockerAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

describe.if(await dockerAvailable())("sandbox manager (docker backend)", () => {
  beforeAll(async () => {
    await $`docker pull ${image}`.quiet();
  });

  let restoreGithub: () => void;
  let repoPath: string;
  const createdContainers: string[] = [];

  beforeEach(async () => {
    restoreGithub = installFakeGithubLockApi(owner, repo);
    repoPath = await initRepo();
  });

  afterEach(async () => {
    restoreGithub();
    for (const name of createdContainers.splice(0)) {
      await $`docker rm -f ${name}`.quiet().nothrow();
    }
    await rm(repoPath, { recursive: true, force: true });
  });

  function trackedName(branch: string): string {
    const name = `nook-${owner}-${repo}-${branch}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    createdContainers.push(name);
    return name;
  }

  test("creates a container and checks out the branch inside it", async () => {
    trackedName("feature-x");
    const result = await createSandbox({
      repoPath,
      branch: "feature-x",
      token,
      holder: "agent-a",
      backend: "docker",
      image,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sandbox.backend).toBe("docker");
    expect(result.sandbox.resumed).toBe(false);
    expect(result.sandbox.path).toBe("/workspace");

    const name = `nook-${owner}-${repo}-feature-x`;
    const checkedOutBranch = (await $`docker exec ${name} git -C /workspace rev-parse --abbrev-ref HEAD`.text()).trim();
    expect(checkedOutBranch).toBe("feature-x");
  }, 30000);

  test("a second holder is rejected while the sandbox's lock is held", async () => {
    trackedName("feature-x");
    await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", backend: "docker", image });
    const result = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-b", backend: "docker", image });
    expect(result.ok).toBe(false);
  }, 30000);

  test("resuming with the same holder restarts the existing container instead of recreating it", async () => {
    trackedName("feature-x");
    const first = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", backend: "docker", image });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const name = `nook-${owner}-${repo}-feature-x`;
    await $`docker exec ${name} sh -c ${"echo hello > /workspace/marker.txt"}`.quiet();
    await $`docker stop ${name}`.quiet();

    const second = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", backend: "docker", image });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.sandbox.resumed).toBe(true);
    const marker = (await $`docker exec ${name} cat /workspace/marker.txt`.text()).trim();
    expect(marker).toBe("hello");
  }, 30000);

  test("destroySandbox removes the container, prunes the worktree, and releases the lock", async () => {
    trackedName("feature-x");
    const created = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", backend: "docker", image });
    expect(created.ok).toBe(true);

    const destroyed = await destroySandbox({ repoPath, branch: "feature-x", token, backend: "docker" });
    expect(destroyed.ok).toBe(true);

    const worktreeList = await $`git -C ${repoPath} worktree list --porcelain`.text();
    expect(worktreeList).not.toContain("/workspace");

    const reacquired = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-b", backend: "docker", image });
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) {
      expect(reacquired.sandbox.resumed).toBe(false);
    }
  }, 30000);

  test("destroySandbox refuses to discard uncommitted changes without force", async () => {
    trackedName("feature-x");
    const created = await createSandbox({ repoPath, branch: "feature-x", token, holder: "agent-a", backend: "docker", image });
    expect(created.ok).toBe(true);

    const name = `nook-${owner}-${repo}-feature-x`;
    await $`docker exec ${name} sh -c ${"echo dirty > /workspace/dirty.txt"}`.quiet();

    const refused = await destroySandbox({ repoPath, branch: "feature-x", token, backend: "docker" });
    expect(refused.ok).toBe(false);

    const forced = await destroySandbox({ repoPath, branch: "feature-x", token, backend: "docker", force: true });
    expect(forced.ok).toBe(true);
  }, 30000);

  test("branches a brand-new sandbox off origin/main when the repo has no local main branch", async () => {
    await git(repoPath, ["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
    await git(repoPath, ["checkout", "-q", "-b", "scratch"]);
    await git(repoPath, ["branch", "-D", "main"]);

    trackedName("feature-z");
    const result = await createSandbox({
      repoPath,
      branch: "feature-z",
      token,
      holder: "agent-a",
      backend: "docker",
      image,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const name = `nook-${owner}-${repo}-feature-z`;
    const checkedOutBranch = (await $`docker exec ${name} git -C /workspace rev-parse --abbrev-ref HEAD`.text()).trim();
    expect(checkedOutBranch).toBe("feature-z");

    // The regression this guards against: mainBranch used to come back as
    // "origin/main" here, which breaks the GitHub PR "base" field.
    const ctx = await resolveGitContext(repoPath);
    expect(ctx.mainBranch).toBe("main");
  }, 30000);
});
