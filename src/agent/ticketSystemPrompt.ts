import { PROPOSED_ISSUE_LABEL, WORKSPACE_DOCUMENTS } from "../config";
import type { IssueComment, OpenIssueRef, ProposedIssue } from "./ticketTools";

/**
 * The harness's own operating instructions for the ticket-extraction agent — not
 * project content, so it doesn't duplicate CONCEPT.md (CONCEPT.md principle
 * 3). Deliberately does not mention CONCEPT.md/FEATURE.md or the source
 * tree: this agent reads only ROADMAP.md's and HANDOFF.md's already-human-
 * curated "known gap" sections (FEATURE.md's confirmed scope for this
 * agent), so it can't misjudge implementation status from doc text alone.
 */
const TICKET_EXTRACTION_PREAMBLE = `You are the ticket-extraction agent running inside an execution harness.

Your only job is turning gaps the human has already flagged — ${WORKSPACE_DOCUMENTS.roadmap}'s
"次の優先順位" (next priorities) and "未解決の論点" (open questions), and
${WORKSPACE_DOCUMENTS.handoff}'s "次のセッションへの申し送り" (handoff to the next session) — into
GitHub issues labeled '${PROPOSED_ISSUE_LABEL}'. These are excerpts of a Japanese-
language project's documents; the gaps themselves may be written in Japanese,
and it's fine to write issue titles/bodies in Japanese to match.

You do not invent new project direction. If everything below is already
covered by an existing open issue, or nothing reads like an actionable gap,
create nothing and say so — deciding to reconsider the project's direction is
a human judgment call, handled through the docs agent, not by you.

You have a create_issue tool, capped at a fixed number of calls this run.
You have no read/write/edit/bash/create_pull_request tools: you cannot open
${WORKSPACE_DOCUMENTS.concept}, ${WORKSPACE_DOCUMENTS.feature}, or the source code, and filing issues from the
excerpts below doesn't require it.`;

function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (startIdx === -1) return null;
  const relativeEndIdx = lines.slice(startIdx + 1).findIndex((line) => /^##\s/.test(line));
  const endIdx = relativeEndIdx === -1 ? lines.length : startIdx + 1 + relativeEndIdx;
  return lines.slice(startIdx, endIdx).join("\n").trim();
}

export function extractRoadmapGaps(roadmap: string | null): string {
  if (roadmap === null) return `(${WORKSPACE_DOCUMENTS.roadmap} not found)`;
  const sections = ["次の優先順位", "未解決の論点"]
    .map((heading) => extractSection(roadmap, heading))
    .filter((section): section is string => section !== null);
  return sections.length > 0
    ? sections.join("\n\n")
    : `(neither section found in ${WORKSPACE_DOCUMENTS.roadmap})`;
}

export function extractHandoffNote(handoff: string | null): string {
  if (handoff === null) return `(${WORKSPACE_DOCUMENTS.handoff} not found)`;
  return (
    extractSection(handoff, "次のセッションへの申し送り") ??
    `(section not found in ${WORKSPACE_DOCUMENTS.handoff})`
  );
}

function renderOpenIssues(issues: OpenIssueRef[]): string {
  if (issues.length === 0) return "(no open issues)";
  return issues.map((issue) => `#${issue.number} ${issue.title} — ${issue.url}`).join("\n");
}

export interface BuildTicketExtractionSystemPromptOptions {
  roadmap: string | null;
  handoff: string | null;
  openIssues: OpenIssueRef[];
  maxIssues: number;
}

export function buildTicketExtractionSystemPrompt(options: BuildTicketExtractionSystemPromptOptions): string {
  return [
    TICKET_EXTRACTION_PREAMBLE,
    `You may create at most ${options.maxIssues} issue(s) in this run.`,
    `## ${WORKSPACE_DOCUMENTS.roadmap} gaps\n\n${extractRoadmapGaps(options.roadmap)}`,
    `## ${WORKSPACE_DOCUMENTS.handoff} handoff\n\n${extractHandoffNote(options.handoff)}`,
    `## Existing open issues (check before filing — avoid duplicates)\n\n${renderOpenIssues(options.openIssues)}`,
  ].join("\n\n");
}

const TICKET_REPLY_PREAMBLE = `You are the ticket-extraction agent running inside an execution harness, continuing a
conversation on a GitHub issue you previously opened (labeled '${PROPOSED_ISSUE_LABEL}').
A human has posted a new comment in the thread below.

Reply with reply_to_issue only — you have no other tools. You cannot edit
this issue's title or body: keep the agreed-upon history in the comment
thread, and leave folding any confirmed change into the actual docs to the
human.`;

export interface BuildTicketReplySystemPromptOptions {
  issue: ProposedIssue;
  comments: IssueComment[];
}

export function buildTicketReplySystemPrompt(options: BuildTicketReplySystemPromptOptions): string {
  const thread = [
    `Issue #${options.issue.number}: ${options.issue.title}`,
    options.issue.body ? `Body:\n${options.issue.body}` : "Body: (empty)",
    "",
    ...options.comments.map((comment) => `${comment.login || "(unknown)"}: ${comment.body}`),
  ].join("\n");
  return [TICKET_REPLY_PREAMBLE, `## Issue thread\n\n${thread}`].join("\n\n");
}
