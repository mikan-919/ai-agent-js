import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { detectMainBranch, refExists, resolveRef, run as runGit } from "../context/git";

export function worktreePath(baseDir: string, owner: string, repo: string, branch: string): string {
  return join(baseDir, `${owner}-${repo}`, branch.replace(/\//g, "-"));
}

export async function hasWorktree(repoPath: string, worktreeDir: string): Promise<boolean> {
  const output = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  const target = resolve(worktreeDir);
  return output.split("\n\n").some((block) => {
    const line = block.split("\n").find((l) => l.startsWith("worktree "));
    return line !== undefined && resolve(line.slice("worktree ".length)) === target;
  });
}

/**
 * Picks the ref to branch the worktree from: an existing local branch, an
 * existing remote-tracking branch, or (for a brand-new branch) the main
 * branch. Does not fetch — v1 relies on refs already present from whatever
 * last synced this checkout, consistent with the polling model elsewhere.
 */
export async function ensureWorktree(repoPath: string, worktreeDir: string, branch: string): Promise<void> {
  await mkdir(dirname(worktreeDir), { recursive: true });

  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    await runGit(repoPath, ["worktree", "add", worktreeDir, branch]);
    return;
  }

  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    await runGit(repoPath, ["worktree", "add", "-b", branch, worktreeDir, `origin/${branch}`]);
    return;
  }

  const mainBranch = await detectMainBranch(repoPath);
  const startPoint = await resolveRef(repoPath, mainBranch);
  await runGit(repoPath, ["worktree", "add", "-b", branch, worktreeDir, startPoint]);
}

/** Throws on failure (e.g. uncommitted changes without `force`); caller decides how to handle it. */
export async function removeWorktree(repoPath: string, worktreeDir: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove", worktreeDir, ...(force ? ["--force"] : [])];
  await runGit(repoPath, args);
}
