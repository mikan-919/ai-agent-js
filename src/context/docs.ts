import { join } from "node:path";
import { DRIFT_WATCHED_DOCUMENT_FILES, WORKSPACE_DOCUMENT_FILES } from "../config";
import type { DocsContext, GitDiffFileStat } from "./types";

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return await file.text();
}

/**
 * Docs whose drift against main is worth flagging to the agent: the concept
 * and roadmap documents. The feature and handoff documents
 * are excluded — HANDOFF.md is expected to differ per-branch by design (it's
 * a per-session note), and FEATURE.md drift isn't tracked separately from
 * ROADMAP.md per the confirmed v1 scope (FEATURE.md "やらないこと").
 */
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
  return DRIFT_WATCHED_DOCUMENT_FILES.filter((name) => changed.has(name));
}

export async function resolveDocsContext(repoPath: string, diffFiles: GitDiffFileStat[]): Promise<DocsContext> {
  const [concept, roadmap, feature, handoff] = await Promise.all(
    WORKSPACE_DOCUMENT_FILES.map((file) => readIfExists(join(repoPath, file))),
  );
  return {
    concept: concept ?? null,
    roadmap: roadmap ?? null,
    feature: feature ?? null,
    handoff: handoff ?? null,
    driftedAgainstMain: detectDocsDrift(diffFiles),
  };
}
