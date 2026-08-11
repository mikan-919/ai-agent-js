import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { defaultTranscriptsBaseDir, deleteTranscript, transcriptPath } from "../agent/transcript";
import { PROJECT_STATE_DIRECTORY } from "../config";
import { getOwnerRepo } from "../context/github";
import { containerName, DEFAULT_DOCKER_IMAGE, destroyDockerSandbox, ensureDockerSandbox } from "./docker";
import { acquireLock, getLockStatus, releaseLock } from "../lock";
import type { CreateSandboxResult, DestroySandboxResult, SandboxBackend } from "./types";
import { ensureWorktree, hasWorktree, removeWorktree, worktreePath } from "./worktree";

function defaultHolder(): string {
  return `${hostname()}:${process.pid}`;
}

function defaultBaseDir(): string {
  return join(homedir(), PROJECT_STATE_DIRECTORY, "sandboxes");
}

export interface CreateSandboxOptions {
  /** Path to the main checkout that worktrees are added from. */
  repoPath: string;
  branch: string;
  token: string;
  /** Defaults to `hostname:pid`. */
  holder?: string;
  note?: string | null;
  /** Defaults to "worktree". */
  backend?: SandboxBackend;
  /** git worktree backend only. Defaults to the application's state directory. */
  baseDir?: string;
  /** docker backend only. Defaults to `DEFAULT_DOCKER_IMAGE`. */
  image?: string;
  ttlMs?: number;
}

/**
 * Sandbox creation and lock acquisition are the same operation: a sandbox
 * without the lock isn't safe to hand to an agent. If `holder` already
 * holds a live lock on `branch`, this is a resume — the existing worktree
 * (or container) is reused instead of re-acquiring (acquireLock has no
 * concept of "reacquire by the same holder", so that check lives here).
 */
export async function createSandbox(opts: CreateSandboxOptions): Promise<CreateSandboxResult> {
  const holder = opts.holder ?? defaultHolder();
  const backend = opts.backend ?? "worktree";

  const ownerRepo = await getOwnerRepo(opts.repoPath);
  if (!ownerRepo) {
    return { ok: false, error: `could not determine owner/repo from git remote 'origin' in ${opts.repoPath}` };
  }
  const { owner, repo } = ownerRepo;

  try {
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

    if (backend === "docker") {
      const name = containerName(owner, repo, opts.branch);
      const { path, resumed } = await ensureDockerSandbox(
        opts.repoPath,
        opts.branch,
        name,
        opts.image ?? DEFAULT_DOCKER_IMAGE,
      );
      return {
        ok: true,
        sandbox: { branch: opts.branch, backend, path, holder, createdAt: new Date().toISOString(), resumed },
      };
    }

    const worktreeDir = worktreePath(opts.baseDir ?? defaultBaseDir(), owner, repo, opts.branch);
    const resumed = await hasWorktree(opts.repoPath, worktreeDir);
    if (!resumed) {
      await ensureWorktree(opts.repoPath, worktreeDir, opts.branch);
    }
    return {
      ok: true,
      sandbox: { branch: opts.branch, backend, path: worktreeDir, holder, createdAt: new Date().toISOString(), resumed },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface DestroySandboxOptions {
  repoPath: string;
  branch: string;
  token: string;
  /** Defaults to "worktree". */
  backend?: SandboxBackend;
  /** git worktree backend only. */
  baseDir?: string;
  /** Force-remove the worktree/container even with uncommitted changes. Defaults to false. */
  force?: boolean;
}

/**
 * Removes the worktree (or container) and releases the lock. If removal
 * fails (e.g. uncommitted changes and `force` not set), the lock is left
 * held so sandbox and lock state don't drift apart — retry with
 * `force: true` once the caller has decided what to do with the changes.
 */
export async function destroySandbox(opts: DestroySandboxOptions): Promise<DestroySandboxResult> {
  const ownerRepo = await getOwnerRepo(opts.repoPath);
  if (!ownerRepo) {
    return { ok: false, error: `could not determine owner/repo from git remote 'origin' in ${opts.repoPath}` };
  }
  const { owner, repo } = ownerRepo;
  const backend = opts.backend ?? "worktree";

  try {
    if (backend === "docker") {
      const name = containerName(owner, repo, opts.branch);
      await destroyDockerSandbox(opts.repoPath, name, opts.force ?? false);
    } else {
      const worktreeDir = worktreePath(opts.baseDir ?? defaultBaseDir(), owner, repo, opts.branch);
      if (await hasWorktree(opts.repoPath, worktreeDir)) {
        await removeWorktree(opts.repoPath, worktreeDir, opts.force ?? false);
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Best-effort: the transcript is disposable cached state, not something
  // worth failing an otherwise-successful destroy over.
  await deleteTranscript(transcriptPath(defaultTranscriptsBaseDir(), owner, repo, opts.branch)).catch(() => {});

  return await releaseLock({ owner, repo, branch: opts.branch, token: opts.token });
}
