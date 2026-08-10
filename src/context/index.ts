import { resolveDocsContext } from "./docs";
import { resolveGitContext } from "./git";
import { resolveGithubContext } from "./github";
import { resolveLinearContext } from "./linear";
import type { WorkContext } from "./types";

export * from "./types";

/**
 * Reconstructs the current work context from Git, GitHub, Linear and
 * workspace docs. Takes only a filesystem path so it stays decoupled from
 * how that path came to exist (plain checkout, worktree, container, ...).
 */
export async function resolveWorkContext(repoPath: string): Promise<WorkContext> {
  const git = await resolveGitContext(repoPath);

  const [github, linear, docs] = await Promise.all([
    resolveGithubContext(repoPath, git.branch),
    resolveLinearContext(git.branch),
    resolveDocsContext(repoPath, git.diff.files),
  ]);

  return { git, github, linear, docs };
}
