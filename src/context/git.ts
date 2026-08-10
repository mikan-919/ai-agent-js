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

export async function detectMainBranch(repoPath: string): Promise<string> {
  const candidates = [
    { ref: "refs/heads/main", name: "main" },
    { ref: "refs/heads/master", name: "master" },
    { ref: "refs/remotes/origin/main", name: "origin/main" },
    { ref: "refs/remotes/origin/master", name: "origin/master" },
  ];
  for (const candidate of candidates) {
    if (await refExists(repoPath, candidate.ref)) {
      return candidate.name;
    }
  }
  throw new Error(
    `could not detect main branch in ${repoPath}: none of main/master (local or origin) exist`,
  );
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

  const numstatOutput = await run(repoPath, ["diff", "--numstat", mainBranch, "HEAD"]);
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
