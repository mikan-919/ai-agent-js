import { join } from "node:path";
import type { DocsContext, GitDiffFileStat } from "./types";

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return await file.text();
}

/**
 * Docs whose drift against main is worth flagging to the agent: CONCEPT.md
 * (why nook exists) and ROADMAP.md (where it's headed). FEATURE.md/HANDOFF.md
 * are excluded — HANDOFF.md is expected to differ per-branch by design (it's
 * a per-session note), and FEATURE.md drift isn't tracked separately from
 * ROADMAP.md per the confirmed v1 scope (FEATURE.md "やらないこと").
 */
const DRIFT_WATCHED_DOCS = ["CONCEPT.md", "ROADMAP.md"] as const;

/**
 * Detects doc drift from the already-computed branch-vs-main diff (git.ts),
 * rather than issuing a separate git call — a file's presence in that diff
 * means its content differs between branch HEAD and main HEAD, which is
 * exactly what "drift" means here. Per FEATURE.md's confirmed v1 scope, this
 * is a plain two-point (branch HEAD vs main HEAD) comparison; merge-base
 * based three-point distinction is explicitly out of scope.
 */
export function detectDocsDrift(diffFiles: GitDiffFileStat[]): string[] {
  const changed = new Set(diffFiles.map((f) => f.path));
  return DRIFT_WATCHED_DOCS.filter((name) => changed.has(name));
}

export async function resolveDocsContext(repoPath: string, diffFiles: GitDiffFileStat[]): Promise<DocsContext> {
  const [concept, roadmap, feature, handoff] = await Promise.all([
    readIfExists(join(repoPath, "CONCEPT.md")),
    readIfExists(join(repoPath, "ROADMAP.md")),
    readIfExists(join(repoPath, "FEATURE.md")),
    readIfExists(join(repoPath, "HANDOFF.md")),
  ]);
  return { concept, roadmap, feature, handoff, driftedAgainstMain: detectDocsDrift(diffFiles) };
}
