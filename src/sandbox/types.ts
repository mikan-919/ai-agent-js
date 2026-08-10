export type SandboxBackend = "worktree" | "docker";

export interface SandboxInfo {
  branch: string;
  backend: SandboxBackend;
  path: string;
  holder: string;
  createdAt: string;
  /** True if an existing worktree (or container) for this branch was reused rather than created. */
  resumed: boolean;
}

export type CreateSandboxResult =
  | { ok: true; sandbox: SandboxInfo }
  | { ok: false; error: string };

export type DestroySandboxResult = { ok: true } | { ok: false; error: string };
