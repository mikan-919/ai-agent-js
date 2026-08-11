import type { WorkContext } from "../context";
import type { CreateSandboxResult, DestroySandboxResult } from "../sandbox";

const EXCERPT_MAX_LEN = 160;

/**
 * Pulls a one-line title + first paragraph out of a workspace doc. Doc
 * files can run to dozens of lines; `status` only needs enough to remind
 * the reader what the doc is about, not to reproduce it (that's what
 * opening the file is for).
 */
function extractExcerpt(markdown: string): { heading: string; summary: string | null } {
  const lines = markdown.split("\n");
  let idx = 0;
  while (idx < lines.length && lines[idx]!.trim().length === 0) idx++;
  const heading = (lines[idx] ?? "").replace(/^#+\s*/, "").trim();
  idx++;

  while (idx < lines.length && (lines[idx]!.trim().length === 0 || lines[idx]!.trim().startsWith("#"))) idx++;

  let summary: string | null = null;
  if (idx < lines.length) {
    summary = lines[idx]!.trim();
    if (summary.length > EXCERPT_MAX_LEN) {
      summary = `${summary.slice(0, EXCERPT_MAX_LEN).trimEnd()}…`;
    }
  }
  return { heading, summary };
}

function formatDocExcerpt(text: string | null): string {
  if (text === null) return "(not found)";
  const { heading, summary } = extractExcerpt(text);
  return summary ? `${heading} — ${summary}` : heading;
}

export function formatWorkContext(ctx: WorkContext): string {
  const lines: string[] = [];

  lines.push(`Branch: ${ctx.git.branch} (main: ${ctx.git.mainBranch})`);
  const { filesChanged, insertions, deletions } = ctx.git.diff;
  lines.push(`Diff: ${filesChanged} file${filesChanged === 1 ? "" : "s"} changed, +${insertions} -${deletions}`);

  lines.push("", "GitHub:");
  if (ctx.github.ok) {
    const { pullRequest, linkedIssues } = ctx.github.data;
    if (pullRequest) {
      const draft = pullRequest.isDraft ? " [draft]" : "";
      lines.push(
        `  PR #${pullRequest.number}${draft} ${pullRequest.title} (${pullRequest.state}) ${pullRequest.url}`,
      );
      lines.push(
        `  Review: ${pullRequest.reviewDecision ?? "no review yet"} · Checks: ${pullRequest.checksStatus ?? "no checks"}`,
      );
      if (linkedIssues.length > 0) {
        lines.push(`  Linked issues: ${linkedIssues.map((issue) => `#${issue.number}`).join(", ")}`);
      }
    } else {
      lines.push("  no PR yet for this branch");
    }
  } else {
    lines.push(`  unavailable: ${ctx.github.reason}`);
  }

  lines.push("", "Linear:");
  if (ctx.linear.ok) {
    const issue = ctx.linear.data;
    lines.push(`  ${issue.identifier} ${issue.title} (${issue.state.name}) ${issue.url}`);
  } else {
    lines.push(`  unavailable: ${ctx.linear.reason}`);
  }

  lines.push("", "Docs:");
  if (ctx.docs.driftedAgainstMain.length > 0) {
    lines.push(`  drift vs ${ctx.git.mainBranch}: ${ctx.docs.driftedAgainstMain.join(", ")}`);
  }
  lines.push(`  CONCEPT.md: ${formatDocExcerpt(ctx.docs.concept)}`);
  lines.push(`  ROADMAP.md: ${formatDocExcerpt(ctx.docs.roadmap)}`);
  lines.push(`  FEATURE.md: ${formatDocExcerpt(ctx.docs.feature)}`);
  lines.push(`  HANDOFF.md: ${formatDocExcerpt(ctx.docs.handoff)}`);

  return lines.join("\n");
}

export function formatCreateSandboxResult(result: CreateSandboxResult): string {
  if (!result.ok) return `error: ${result.error}`;
  const { sandbox } = result;
  const status = sandbox.resumed ? "resumed" : "created";
  return `sandbox ${status}: ${sandbox.branch} [${sandbox.backend}] -> ${sandbox.path} (holder: ${sandbox.holder})`;
}

export function formatDestroySandboxResult(branch: string, result: DestroySandboxResult): string {
  if (!result.ok) return `error: ${result.error}`;
  return `sandbox destroyed: ${branch}`;
}
