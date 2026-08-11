import { $ } from "bun";
import type { GitContext, GitDiffFileStat } from "./types";

export async function run(repoPath: string, args: string[]): Promise<string> {
  const result = await $`git -C ${repoPath} ${args}`.text();
  return result.trim();
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "-C", repoPath, "show-ref", "--verify", "--quiet", ref], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

const MAIN_BRANCH_CANDIDATES = ["main", "master"];

/**
 * The repo's main branch *name* — always a bare name ("main"/"master"),
 * never a remote-tracking ref like "origin/main", even when only the
 * remote-tracking branch exists locally. This matters because callers treat
 * the result as a branch identity, not just something `git` can resolve: it
 * flows into GitHub's PR "base" field (which rejects "origin/main") and into
 * docsTools' "refuse to push directly to main" guard (which compares it
 * against the checked-out branch name, itself always bare). Use resolveRef()
 * when a git operation needs something it can actually resolve as a commit.
 */
export async function detectMainBranch(repoPath: string): Promise<string> {
  for (const name of MAIN_BRANCH_CANDIDATES) {
    if (await refExists(repoPath, `refs/heads/${name}`)) return name;
  }
  for (const name of MAIN_BRANCH_CANDIDATES) {
    if (await refExists(repoPath, `refs/remotes/origin/${name}`)) return name;
  }
  throw new Error(
    `could not detect main branch in ${repoPath}: none of main/master (local or origin) exist`,
  );
}

/**
 * A ref `git` can resolve to `branch`'s commit: the local branch if it
 * exists, otherwise its remote-tracking counterpart. Needed alongside
 * detectMainBranch/branch names in general because a bare name doesn't
 * resolve on its own when only the remote-tracking branch is present.
 */
export async function resolveRef(repoPath: string, branch: string): Promise<string> {
  if (await refExists(repoPath, `refs/heads/${branch}`)) return branch;
  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) return `origin/${branch}`;
  throw new Error(`could not resolve ref for branch '${branch}' in ${repoPath}: no local or origin ref found`);
}

function parseNumstat(output: string): GitDiffFileStat[] {
  if (output.length === 0) return [];
  return output.split("\n").map((line) => {
    const [insertionsRaw, deletionsRaw, path] = line.split("\t");
    const binary = insertionsRaw === "-" || deletionsRaw === "-";
    return {
      path: path ?? "",
      insertions: binary ? 0 : Number(insertionsRaw),
      deletions: binary ? 0 : Number(deletionsRaw),
      binary,
    };
  });
}

export async function resolveGitContext(repoPath: string): Promise<GitContext> {
  const branch = await run(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const mainBranch = await detectMainBranch(repoPath);
  const mainRef = await resolveRef(repoPath, mainBranch);

  const numstatOutput = await run(repoPath, ["diff", "--numstat", mainRef, "HEAD"]);
  const files = parseNumstat(numstatOutput);

  const insertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    branch,
    mainBranch,
    diff: {
      files,
      filesChanged: files.length,
      insertions,
      deletions,
    },
  };
}
