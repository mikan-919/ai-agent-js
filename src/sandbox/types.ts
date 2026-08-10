export interface SandboxInfo {
  branch: string;
  path: string;
  holder: string;
  createdAt: string;
  /** True if an existing worktree for this branch was reused rather than created. */
  resumed: boolean;
}

export type CreateSandboxResult =
  | { ok: true; sandbox: SandboxInfo }
  | { ok: false; error: string };

export type DestroySandboxResult = { ok: true } | { ok: false; error: string };
