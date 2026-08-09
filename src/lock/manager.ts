import type { AcquireLockResult, LockInfo, LockStatus, ReleaseLockResult } from "./types";

const GITHUB_API = "https://api.github.com";

/** Default hold time before a lock is considered abandoned and stealable. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

function refPath(branch: string): string {
  return `harness-locks/${branch}`;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "har",
  };
}

interface CommitRef {
  sha: string;
  treeSha: string;
}

async function getBranchHead(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<CommitRef> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${branch}`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`could not resolve branch head for '${branch}': ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { sha: string; commit: { tree: { sha: string } } };
  return { sha: json.sha, treeSha: json.commit.tree.sha };
}

/**
 * Marker commits are deliberately parentless — they exist only to be
 * pointed at by the lock ref, not to join the branch's history.
 */
async function createLockCommit(
  owner: string,
  repo: string,
  token: string,
  treeSha: string,
  message: string,
  date: Date,
): Promise<string> {
  const iso = date.toISOString();
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [],
      author: { name: "har", email: "har@localhost", date: iso },
      committer: { name: "har", email: "har@localhost", date: iso },
    }),
  });
  if (!response.ok) {
    throw new Error(`could not create lock marker commit: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { sha: string };
  return json.sha;
}

/** Returns true if the ref was created, false if it already existed. */
async function createLockRef(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  commitSha: string,
): Promise<boolean> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/${refPath(branch)}`, sha: commitSha }),
  });
  if (response.status === 201) return true;
  if (response.status === 422) return false;
  throw new Error(`could not create lock ref: ${response.status} ${response.statusText}`);
}

async function deleteLockRef(owner: string, repo: string, token: string, branch: string): Promise<void> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/${refPath(branch)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`could not delete lock ref: ${response.status} ${response.statusText}`);
  }
}

async function getLockRefSha(
  owner: string,
  repo: string,
  token: string,
  branch: string,
): Promise<string | null> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/${refPath(branch)}`, {
    headers: authHeaders(token),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`could not read lock ref: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { object: { sha: string } };
  return json.object.sha;
}

async function readLock(
  owner: string,
  repo: string,
  token: string,
  branch: string,
): Promise<LockInfo | null> {
  const sha = await getLockRefSha(owner, repo, token, branch);
  if (!sha) return null;

  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${sha}`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`could not read lock marker commit: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as {
    message: string;
    committer: { date: string };
  };

  let holder = "unknown";
  let note: string | null = null;
  try {
    const parsed = JSON.parse(json.message) as { holder?: string; note?: string | null };
    if (typeof parsed.holder === "string") holder = parsed.holder;
    if (typeof parsed.note === "string") note = parsed.note;
  } catch {
    // Marker commit predates or was created outside this scheme; keep defaults.
  }

  return { branch, holder, acquiredAt: json.committer.date, note };
}

interface CreateAttempt {
  created: boolean;
  lock: LockInfo;
}

async function tryCreateLock(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  holder: string,
  note: string | null,
): Promise<CreateAttempt> {
  const head = await getBranchHead(owner, repo, branch, token);
  const acquiredAt = new Date();
  const lock: LockInfo = { branch, holder, acquiredAt: acquiredAt.toISOString(), note };
  const commitSha = await createLockCommit(
    owner,
    repo,
    token,
    head.treeSha,
    JSON.stringify({ holder, note }),
    acquiredAt,
  );
  const created = await createLockRef(owner, repo, token, branch, commitSha);
  return { created, lock };
}

export interface AcquireLockOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  holder: string;
  note?: string | null;
  ttlMs?: number;
}

/**
 * Acquires refs/harness-locks/<branch> for `holder`. Ref creation is the
 * only atomic step (GitHub's create-ref API fails if the ref already
 * exists), so that is what actually decides who wins. A held lock older
 * than ttlMs is treated as abandoned: we delete it and race to re-create
 * it, same as a fresh acquire, so concurrent stealers still resolve to
 * exactly one winner.
 */
export async function acquireLock(opts: AcquireLockOptions): Promise<AcquireLockResult> {
  const { owner, repo, branch, token, holder, ttlMs = DEFAULT_TTL_MS } = opts;
  const note = opts.note ?? null;

  const first = await tryCreateLock(owner, repo, token, branch, holder, note);
  if (first.created) {
    return { ok: true, lock: first.lock, stolen: false };
  }

  const existing = await readLock(owner, repo, token, branch);
  if (!existing) {
    // Ref vanished between the failed create and this read (raced with a
    // release). Caller can simply retry; report as contended rather than
    // looping here to keep this function's behavior predictable.
    return { ok: false, error: "lock ref state changed concurrently; retry" };
  }

  const age = Date.now() - new Date(existing.acquiredAt).getTime();
  if (age <= ttlMs) {
    return {
      ok: false,
      error: `branch '${branch}' is locked by '${existing.holder}' (held ${Math.round(age / 1000)}s, ttl ${Math.round(ttlMs / 1000)}s)`,
      heldBy: existing,
    };
  }

  await deleteLockRef(owner, repo, token, branch);
  const steal = await tryCreateLock(owner, repo, token, branch, holder, note);
  if (steal.created) {
    return { ok: true, lock: steal.lock, stolen: true };
  }

  const afterSteal = await readLock(owner, repo, token, branch);
  return {
    ok: false,
    error: `lock on branch '${branch}' expired but was stolen by another holder first`,
    heldBy: afterSteal ?? undefined,
  };
}

export interface ReleaseLockOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export async function releaseLock(opts: ReleaseLockOptions): Promise<ReleaseLockResult> {
  const { owner, repo, branch, token } = opts;
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/${refPath(branch)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (response.status === 404) {
    return { ok: false, error: `no lock held for branch '${branch}'` };
  }
  if (!response.ok) {
    return { ok: false, error: `could not delete lock ref: ${response.status} ${response.statusText}` };
  }
  return { ok: true };
}

export interface LockStatusOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  ttlMs?: number;
}

export async function getLockStatus(opts: LockStatusOptions): Promise<LockStatus> {
  const { owner, repo, branch, token, ttlMs = DEFAULT_TTL_MS } = opts;
  const lock = await readLock(owner, repo, token, branch);
  if (!lock) return { locked: false };
  const age = Date.now() - new Date(lock.acquiredAt).getTime();
  return { locked: true, lock, expired: age > ttlMs };
}
