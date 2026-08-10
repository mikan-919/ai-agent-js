import type { SandboxBackend } from "../sandbox";

export interface SandboxArgs {
  branch: string;
  backend: SandboxBackend;
  force: boolean;
  json: boolean;
}

/** Shared arg parsing for `sandbox create` / `sandbox destroy`; `force` is a no-op for create. */
export function parseSandboxArgs(args: string[]): SandboxArgs {
  const positional: string[] = [];
  let backend: SandboxBackend = "worktree";
  let force = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--backend") {
      const value = args[++i];
      if (value !== "worktree" && value !== "docker") {
        throw new Error(`--backend must be 'worktree' or 'docker', got '${value ?? ""}'`);
      }
      backend = value;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag '${arg}'`);
    } else {
      positional.push(arg);
    }
  }

  const branch = positional[0];
  if (!branch) {
    throw new Error("branch is required");
  }
  return { branch, backend, force, json };
}
