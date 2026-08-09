/**
 * A lock is a git ref (refs/harness-locks/<branch>) pointing at a marker
 * commit. The commit's committer date is the authoritative acquisition
 * time (set by us, read back from GitHub rather than trusted from the
 * message) and its message carries holder identity as JSON.
 */
export interface LockInfo {
  branch: string;
  holder: string;
  acquiredAt: string;
  note: string | null;
}

export type AcquireLockResult =
  | { ok: true; lock: LockInfo; stolen: boolean }
  | { ok: false; error: string; heldBy?: LockInfo };

export type ReleaseLockResult = { ok: true } | { ok: false; error: string };

export type LockStatus =
  | { locked: false }
  | { locked: true; lock: LockInfo; expired: boolean };
