import { detectMainBranch } from "../context/git";
import { getOwnerRepo } from "../context/github";
import { PROPOSED_ISSUE_LABEL, WORKSPACE_DOCUMENTS } from "../config";
import { destroySandbox } from "../sandbox";
import { createSession } from "./session";
import { buildTicketExtractionSystemPrompt, buildTicketReplySystemPrompt } from "./ticketSystemPrompt";
import {
  createCreateIssueTool,
  createReplyToIssueTool,
  getAuthenticatedLogin,
  listIssueComments,
  listOpenIssues,
  listProposedIssues,
  resolveMaxIssuesPerRun,
} from "./ticketTools";

export type TicketExtractionResult =
  | { ok: true; createdCount: number; summary: string }
  | { ok: false; createdCount: number; error: string; timedOut?: boolean };

/**
 * One extraction pass: files proposed issues for gaps already flagged in the
 * roadmap/handoff documents. Shared by the ticket CLI command and the
 * server's periodic wiring (see serve.ts) — both just differ in how they
 * report the result, not in what the pass does.
 */
export async function runTicketExtractionPass(repoPath: string, token: string): Promise<TicketExtractionResult> {
  const ownerRepo = await getOwnerRepo(repoPath);
  if (!ownerRepo) {
    return { ok: false, createdCount: 0, error: `could not determine owner/repo from git remote 'origin' in ${repoPath}` };
  }

  const mainBranch = await detectMainBranch(repoPath);
  const maxIssues = resolveMaxIssuesPerRun();
  const createdCount = { current: 0 };
  const openIssues = await listOpenIssues(ownerRepo.owner, ownerRepo.repo, token);

  const sessionResult = await createSession({
    repoPath,
    branch: mainBranch,
    token,
    createTools: (ctx) => [
      createCreateIssueTool({ owner: ctx.owner, repo: ctx.repo, token: ctx.token, maxIssues, createdCount }),
    ],
    buildSystemPrompt: ({ workContext }) =>
      buildTicketExtractionSystemPrompt({
        roadmap: workContext.docs.roadmap,
        handoff: workContext.docs.handoff,
        openIssues,
        maxIssues,
      }),
  });

  if (!sessionResult.ok) {
    return { ok: false, createdCount: 0, error: sessionResult.error };
  }
  const { session } = sessionResult;

  const result = await session.send(
    `Review ${WORKSPACE_DOCUMENTS.roadmap}'s next priorities and open questions, and ${WORKSPACE_DOCUMENTS.handoff}'s ` +
      "handoff note, for gaps that don't yet have a matching open issue. File a " +
      `${PROPOSED_ISSUE_LABEL} issue for each genuinely new gap; skip anything the existing ` +
      "open issues already cover. If there's nothing new, create nothing and say so.",
  );
  await session.close();
  await destroySandbox({ repoPath, branch: mainBranch, token });

  if (!result.ok) {
    return {
      ok: false,
      createdCount: createdCount.current,
      error: result.error ?? "unknown error",
      timedOut: result.timedOut,
    };
  }

  return { ok: true, createdCount: createdCount.current, summary: result.summary ?? "" };
}

export interface TicketPollResult {
  repliedCount: number;
  checkedCount: number;
  /** Per-issue failures (session creation or the reply turn itself). The pass keeps going past these. */
  errors: string[];
}

/**
 * One poll pass over every open proposed issue: replies via reply_to_issue if
 * and only if the latest comment wasn't posted by the harness. Stateless
 * (CONCEPT.md principle 1) — re-derives "does this need a
 * reply" from the thread every call rather than tracking a cursor.
 *
 * Each issue gets its own freshly created-then-destroyed sandbox/lock (see
 * the loop below) rather than one shared across the whole pass, so a
 * previous issue's transcript never leaks into the next issue's reply as
 * "previous session in this sandbox" context (session.ts).
 */
export async function runTicketPollPass(
  repoPath: string,
  token: string,
  onLog?: (message: string) => void,
): Promise<TicketPollResult> {
  const ownerRepo = await getOwnerRepo(repoPath);
  if (!ownerRepo) {
    throw new Error(`could not determine owner/repo from git remote 'origin' in ${repoPath}`);
  }

  const mainBranch = await detectMainBranch(repoPath);
  const botLogin = await getAuthenticatedLogin(token);
  const proposedIssues = await listProposedIssues(ownerRepo.owner, ownerRepo.repo, token);

  let replied = 0;
  const errors: string[] = [];
  for (const issue of proposedIssues) {
    const comments = await listIssueComments(ownerRepo.owner, ownerRepo.repo, issue.number, token);
    const lastComment = comments[comments.length - 1];
    if (!lastComment || lastComment.login === botLogin) continue;

    onLog?.(`replying on issue #${issue.number}…`);

    const sessionResult = await createSession({
      repoPath,
      branch: mainBranch,
      token,
      createTools: (ctx) => [
        createReplyToIssueTool({ owner: ctx.owner, repo: ctx.repo, token: ctx.token, issueNumber: issue.number }),
      ],
      buildSystemPrompt: () => buildTicketReplySystemPrompt({ issue, comments }),
    });

    if (!sessionResult.ok) {
      errors.push(`issue #${issue.number}: ${sessionResult.error}`);
      continue;
    }

    const result = await sessionResult.session.send("Reply to the human's latest comment in the thread above.");
    await sessionResult.session.close();
    await destroySandbox({ repoPath, branch: mainBranch, token });

    if (!result.ok) {
      errors.push(`issue #${issue.number}: ${result.timedOut ? `idle timeout: ${result.error}` : result.error}`);
      continue;
    }
    replied++;
  }

  return { repliedCount: replied, checkedCount: proposedIssues.length, errors };
}
