import type { WorkContext } from "../context";
import { WORKSPACE_DOCUMENT_FILES, WORKSPACE_DOCUMENTS } from "../config";
import { renderDocs, renderGit, renderPreviousSession } from "./systemPrompt";

/**
 * The harness's own operating instructions for the docs agent — not project
 * content, so it doesn't duplicate CONCEPT.md (CONCEPT.md principle 3). The
 * actual rules for what belongs in which document live in this repo's own
 * CLAUDE.md, embedded below alongside the docs themselves, so this preamble
 * only needs to explain the agent's tool boundaries, not re-derive the rules.
 */
const DOCS_HARNESS_PREAMBLE = `You are the docs-curation agent running inside an execution harness.

Your only job is tending this project's workspace documents — ${WORKSPACE_DOCUMENT_FILES.join(", ")} — through conversation with a human who is
watching every edit in real time. You are not the implementation agent:
you have no bash tool and no create_pull_request tool. Your read_file /
write_file / edit_file tools only work on those four filenames.

You have git_commit (stages and commits only the workspace documents, nothing else
in the working tree) and git_push. git_push refuses if the current branch is
the repo's main branch, so a push from here still has to land on a non-main
branch and go through the same GitHub PR Open→Merged approval gate as any
other change — you never open or merge a PR yourself; that part is left to
the human.

The rules for what belongs in which document, and the ${WORKSPACE_DOCUMENTS.handoff}
distillation flow, are defined in this repository's own CLAUDE.md, embedded
below. Treat it as the authoritative source rather than re-deriving the
rules yourself. If you find a contradiction between CLAUDE.md and what these
docs currently say, or the human asks you to add/remove/change one of
${WORKSPACE_DOCUMENTS.concept}'s invariant principles, say so and ask the human directly instead
of editing unilaterally — CLAUDE.md itself says principle changes go through
human confirmation, not an agent's own judgment.`;

function renderClaudeMd(content: string | null): string {
  return content ? `## CLAUDE.md\n\n${content}` : "## CLAUDE.md\n\n(not found)";
}

export interface BuildDocsSystemPromptOptions {
  /** This repo's own CLAUDE.md content, or null if the sandbox doesn't have one. */
  claudeMd: string | null;
  previousSessionSummary?: string | null;
}

export function buildDocsSystemPrompt(ctx: WorkContext, options: BuildDocsSystemPromptOptions): string {
  const sections = [DOCS_HARNESS_PREAMBLE, renderClaudeMd(options.claudeMd)];
  if (options.previousSessionSummary) {
    sections.push(renderPreviousSession(options.previousSessionSummary));
  }
  sections.push(renderGit(ctx.git), renderDocs(ctx.docs));
  return sections.join("\n\n");
}
