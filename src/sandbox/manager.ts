import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { detectMainBranch, refExists, run as runGit } from "../context/git";
import { getOwnerRepo } from "../context/github";
import { acquireLock, getLockStatus, releaseLock } from "../lock";
import type { CreateSandboxResult, DestroySandboxResult } from "./types";

function defaultHolder(): string {
  return `${hostname()}:${process.pid}`;
}

function defaultBaseDir(): string {
  return join(homedir(), ".nook", "sandboxes");
}

function sandboxPath(baseDir: string, owner: string, repo: string, branch: string): string {
  return join(baseDir, `${owner}-${repo}`, branch.replace(/\//g, "-"));
}

async function hasWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  const output = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  const target = resolve(worktreePath);
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
async function ensureWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });

  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    await runGit(repoPath, ["worktree", "add", worktreePath, branch]);
    return;
  }

  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    await runGit(repoPath, ["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`]);
    return;
  }

  const mainBranch = await detectMainBranch(repoPath);
  await runGit(repoPath, ["worktree", "add", "-b", branch, worktreePath, mainBranch]);
}

export interface CreateSandboxOptions {
  /** Path to the main checkout that worktrees are added from. */
  repoPath: string;
  branch: string;
  token: string;
  /** Defaults to `hostname:pid`. */
  holder?: string;
  note?: string | null;
  /** Defaults to `~/.nook/sandboxes`. */
  baseDir?: string;
  ttlMs?: number;
}

/**
 * Sandbox creation and lock acquisition are the same operation: a sandbox
 * without the lock isn't safe to hand to an agent. If `holder` already
 * holds a live lock on `branch`, this is a resume — the existing worktree
 * is reused instead of re-acquiring (acquireLock has no concept of
 * "reacquire by the same holder", so that check lives here).
 */
export async function createSandbox(opts: CreateSandboxOptions): Promise<CreateSandboxResult> {
  const holder = opts.holder ?? defaultHolder();

  const ownerRepo = await getOwnerRepo(opts.repoPath);
  if (!ownerRepo) {
    return { ok: false, error: `could not determine owner/repo from git remote 'origin' in ${opts.repoPath}` };
  }
  const { owner, repo } = ownerRepo;

  const worktreePath = sandboxPath(opts.baseDir ?? defaultBaseDir(), owner, repo, opts.branch);

  const status = await getLockStatus({ owner, repo, branch: opts.branch, token: opts.token, ttlMs: opts.ttlMs });
  const alreadyHeldByUs = status.locked && !status.expired && status.lock.holder === holder;

  if (!alreadyHeldByUs) {
    const acquired = await acquireLock({
      owner,
      repo,
      branch: opts.branch,
      token: opts.token,
      holder,
      note: opts.note,
      ttlMs: opts.ttlMs,
    });
    if (!acquired.ok) {
      return { ok: false, error: acquired.error };
    }
  }

  const resumed = await hasWorktree(opts.repoPath, worktreePath);
  if (!resumed) {
    await ensureWorktree(opts.repoPath, worktreePath, opts.branch);
  }

  return {
    ok: true,
    sandbox: {
      branch: opts.branch,
      path: worktreePath,
      holder,
      createdAt: new Date().toISOString(),
      resumed,
    },
  };
}

export interface DestroySandboxOptions {
  repoPath: string;
  branch: string;
  token: string;
  baseDir?: string;
  /** Force-remove the worktree even with uncommitted changes. Defaults to false. */
  force?: boolean;
}

/**
 * Removes the worktree and releases the lock. If worktree removal fails
 * (e.g. uncommitted changes and `force` not set), the lock is left held so
 * sandbox and lock state don't drift apart — retry with `force: true` once
 * the caller has decided what to do with the changes.
 */
export async function destroySandbox(opts: DestroySandboxOptions): Promise<DestroySandboxResult> {
  const ownerRepo = await getOwnerRepo(opts.repoPath);
  if (!ownerRepo) {
    return { ok: false, error: `could not determine owner/repo from git remote 'origin' in ${opts.repoPath}` };
  }
  const { owner, repo } = ownerRepo;
  const worktreePath = sandboxPath(opts.baseDir ?? defaultBaseDir(), owner, repo, opts.branch);

  if (await hasWorktree(opts.repoPath, worktreePath)) {
    const args = ["worktree", "remove", worktreePath, ...(opts.force ? ["--force"] : [])];
    try {
      await runGit(opts.repoPath, args);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return await releaseLock({ owner, repo, branch: opts.branch, token: opts.token });
}
