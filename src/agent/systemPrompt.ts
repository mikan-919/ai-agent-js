import type { WorkContext } from "../context";

/**
 * nook's own operating instructions for the agent — not project content, so
 * it doesn't duplicate CONCEPT.md (CONCEPT.md principle 3). This explains
 * what the agent may and may not do; the *why* behind those rules lives in
 * CONCEPT.md itself, which is embedded below alongside the rest of docs.
 */
const HARNESS_PREAMBLE = `You are an autonomous coding agent running inside nook, an execution harness.

You are working in a sandbox checked out on a dedicated branch. You have file
read/write/edit tools and a bash tool scoped to this sandbox, plus a
create_pull_request tool.

Two approval gates exist in this project and you cannot pass through either
yourself: a Linear issue moving from Triage to Todo, and a GitHub PR moving
from Open to Merged. Your job ends at proposing a change, not approving it.

Workflow: make the requested change, run whatever checks are appropriate
(tests, typecheck) via the bash tool, commit your work with git (bash tool),
then call create_pull_request with a title and body once the change is ready
for human review. Do not merge, approve, or otherwise try to pass either gate.

The rest of this system prompt is the current work context — git diff state,
GitHub/Linear state, and this project's own workspace documents — reassembled
fresh for this run.`;

function renderGit(git: WorkContext["git"]): string {
  const { files, filesChanged, insertions, deletions } = git.diff;
  const fileLines = files.map((f) => `  ${f.path}: +${f.insertions} -${f.deletions}${f.binary ? " (binary)" : ""}`);
  return [
    "## Git",
    `Branch: ${git.branch} (main: ${git.mainBranch})`,
    `Diff vs ${git.mainBranch}: ${filesChanged} file(s) changed, +${insertions} -${deletions}`,
    ...fileLines,
  ].join("\n");
}

function renderGithub(github: WorkContext["github"]): string {
  if (!github.ok) return ["## GitHub", `unavailable: ${github.reason}`].join("\n");
  const { pullRequest, linkedIssues } = github.data;
  if (!pullRequest) return ["## GitHub", "no PR yet for this branch"].join("\n");
  const lines = [
    "## GitHub",
    `PR #${pullRequest.number}${pullRequest.isDraft ? " [draft]" : ""} ${pullRequest.title} (${pullRequest.state}) ${pullRequest.url}`,
  ];
  if (pullRequest.body) lines.push(`PR body:\n${pullRequest.body}`);
  if (linkedIssues.length > 0) {
    lines.push(`Linked issues: ${linkedIssues.map((i) => `#${i.number} ${i.title} (${i.state})`).join(", ")}`);
  }
  return lines.join("\n");
}

function renderLinear(linear: WorkContext["linear"]): string {
  if (!linear.ok) return ["## Linear", `unavailable: ${linear.reason}`].join("\n");
  const issue = linear.data;
  const lines = [
    "## Linear",
    `${issue.identifier} ${issue.title} (${issue.state.name}, team ${issue.team.name}) ${issue.url}`,
  ];
  if (issue.description) lines.push(`Description:\n${issue.description}`);
  return lines.join("\n");
}

function renderDoc(name: string, content: string | null): string {
  return content ? `### ${name}\n\n${content}` : `### ${name}\n\n(not found)`;
}

function renderPreviousSession(summary: string): string {
  return ["## Previous session in this sandbox", summary].join("\n\n");
}

function renderDocs(docs: WorkContext["docs"]): string {
  const lines = ["## Workspace docs"];
  if (docs.driftedAgainstMain.length > 0) {
    lines.push(
      `⚠️ Drift: ${docs.driftedAgainstMain.join(", ")} differ between this branch and main. ` +
        "The versions embedded below are this branch's, which may be stale relative to main — " +
        "check main's copy before treating them as current project policy.",
    );
  }
  lines.push(
    renderDoc("CONCEPT.md", docs.concept),
    renderDoc("ROADMAP.md", docs.roadmap),
    renderDoc("FEATURE.md", docs.feature),
    renderDoc("HANDOFF.md", docs.handoff),
  );
  return lines.join("\n\n");
}

export interface BuildSystemPromptOptions {
  /**
   * Compressed checkpoint from this sandbox's previous agent run, when
   * resuming one that has it. Not part of WorkContext: unlike git/github/
   * linear/docs, it isn't reconstructed from an external source of truth —
   * it's a summary nook itself generated of the agent's own prior transcript.
   */
  previousSessionSummary?: string | null;
}

export function buildSystemPrompt(ctx: WorkContext, options: BuildSystemPromptOptions = {}): string {
  const sections = [HARNESS_PREAMBLE];
  if (options.previousSessionSummary) {
    sections.push(renderPreviousSession(options.previousSessionSummary));
  }
  sections.push(renderGit(ctx.git), renderGithub(ctx.github), renderLinear(ctx.linear), renderDocs(ctx.docs));
  return sections.join("\n\n");
}
