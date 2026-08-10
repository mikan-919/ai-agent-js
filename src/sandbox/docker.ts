import { resolve } from "node:path";
import { detectMainBranch, refExists, run as runGit } from "../context/git";

export const DEFAULT_DOCKER_IMAGE = "oven/bun:1";
export const CONTAINER_WORKSPACE = "/workspace";

export function containerName(owner: string, repo: string, branch: string): string {
  return `nook-${owner}-${repo}-${branch}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function runDocker(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${(stderr || stdout).trim()}`);
  }
  return stdout.trim();
}

type ContainerState = "running" | "stopped" | "absent";

async function containerState(name: string): Promise<ContainerState> {
  try {
    const status = await runDocker(["inspect", "-f", "{{.State.Status}}", name]);
    return status === "running" ? "running" : "stopped";
  } catch {
    return "absent";
  }
}

/**
 * Bind-mounts the host repo into the container at the same absolute path so
 * `git worktree add`, run via `docker exec`, writes worktree metadata
 * (.git/worktrees/<name>/gitdir) that resolves correctly whether read from
 * inside the container or from the host.
 */
async function createContainer(repoPath: string, name: string, image: string): Promise<void> {
  const hostPath = resolve(repoPath);
  await runDocker([
    "run",
    "-d",
    "--name",
    name,
    "-v",
    `${hostPath}:${hostPath}`,
    "--label",
    "nook.sandbox=true",
    // Overriding the entrypoint means any image works as a passive host: the
    // container is only ever interacted with via `docker exec`, so its own
    // entrypoint/cmd is irrelevant — it just needs to stay alive.
    "--entrypoint",
    "tail",
    image,
    "-f",
    "/dev/null",
  ]);
}

async function execGit(name: string, repoPath: string, args: string[]): Promise<string> {
  return runDocker(["exec", name, "git", "-C", repoPath, ...args]);
}

/** Mirrors worktree.ts's ensureWorktree, except `worktree add` runs inside the container. */
async function ensureContainerWorktree(repoPath: string, name: string, branch: string): Promise<void> {
  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    await execGit(name, repoPath, ["worktree", "add", CONTAINER_WORKSPACE, branch]);
    return;
  }

  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    await execGit(name, repoPath, ["worktree", "add", "-b", branch, CONTAINER_WORKSPACE, `origin/${branch}`]);
    return;
  }

  const mainBranch = await detectMainBranch(repoPath);
  await execGit(name, repoPath, ["worktree", "add", "-b", branch, CONTAINER_WORKSPACE, mainBranch]);
}

export interface EnsureDockerSandboxResult {
  path: string;
  resumed: boolean;
}

/**
 * A container's disk layer holds the actual worktree files, so "resumed"
 * tracks container existence directly: a stopped container is restarted in
 * place, a running one is left alone, and only a genuinely new container
 * needs `git worktree add` run inside it.
 */
export async function ensureDockerSandbox(
  repoPath: string,
  branch: string,
  name: string,
  image: string,
): Promise<EnsureDockerSandboxResult> {
  const state = await containerState(name);

  if (state === "absent") {
    await createContainer(repoPath, name, image);
    await ensureContainerWorktree(repoPath, name, branch);
    return { path: CONTAINER_WORKSPACE, resumed: false };
  }

  if (state === "stopped") {
    await runDocker(["start", name]);
  }

  return { path: CONTAINER_WORKSPACE, resumed: true };
}

/**
 * Removes the container and prunes the worktree metadata it leaves behind in
 * the host repo. `git worktree remove` can't be used here because it stats
 * the worktree directory, which only ever existed inside the now-deleted
 * container; `worktree prune` is the operation meant for exactly that case.
 * Without `force`, a container with uncommitted changes is left running so
 * the caller doesn't silently lose work.
 */
export async function destroyDockerSandbox(repoPath: string, name: string, force: boolean): Promise<void> {
  const state = await containerState(name);

  if (state !== "absent" && !force) {
    if (state === "stopped") await runDocker(["start", name]);
    const status = await runDocker(["exec", name, "git", "-C", CONTAINER_WORKSPACE, "status", "--porcelain"]);
    if (status.length > 0) {
      throw new Error(`container '${name}' has uncommitted changes in ${CONTAINER_WORKSPACE}; use force to discard`);
    }
  }

  if (state !== "absent") {
    await runDocker(["rm", "-f", name]);
  }
  await runGit(repoPath, ["worktree", "prune"]);
}
