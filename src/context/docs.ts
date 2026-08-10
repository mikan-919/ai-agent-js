import { join } from "node:path";
import type { DocsContext } from "./types";

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return await file.text();
}

export async function resolveDocsContext(repoPath: string): Promise<DocsContext> {
  const [concept, roadmap, feature, handoff] = await Promise.all([
    readIfExists(join(repoPath, "CONCEPT.md")),
    readIfExists(join(repoPath, "ROADMAP.md")),
    readIfExists(join(repoPath, "FEATURE.md")),
    readIfExists(join(repoPath, "HANDOFF.md")),
  ]);
  return { concept, roadmap, feature, handoff };
}
