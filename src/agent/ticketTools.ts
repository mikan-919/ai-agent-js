import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const GITHUB_API = "https://api.github.com";

/** Label the ticket-extraction agent uses for every issue it opens, and the only label its poll pass looks for. */
export const PROPOSED_LABEL = "nook:proposed";

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "nook",
  };
}

function textResult(text: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: "text", text }], details: {} };
}

interface GithubIssueListItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  /** Present (with a URL) only when this "issue" is actually a pull request — GitHub's issues endpoint returns both. */
  pull_request?: unknown;
}

export interface OpenIssueRef {
  number: number;
  title: string;
  url: string;
}

/** Existing open issues, for the extraction agent to check against before filing a duplicate. Excludes PRs. */
export async function listOpenIssues(owner: string, repo: string, token: string): Promise<OpenIssueRef[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&per_page=100`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub issues lookup failed: ${response.status} ${response.statusText}`);
  }
  const results = (await response.json()) as GithubIssueListItem[];
  return results
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url }));
}

export interface ProposedIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
}

/** Open issues carrying `nook:proposed`, for the poll pass to check for pending human replies. Excludes PRs. */
export async function listProposedIssues(owner: string, repo: string, token: string): Promise<ProposedIssue[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(PROPOSED_LABEL)}&per_page=100`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub issues lookup failed: ${response.status} ${response.statusText}`);
  }
  const results = (await response.json()) as GithubIssueListItem[];
  return results
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, url: issue.html_url }));
}

export interface IssueComment {
  login: string;
  body: string;
}

export async function listIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<IssueComment[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub issue comments lookup failed: ${response.status} ${response.statusText}`);
  }
  const results = (await response.json()) as { user: { login: string } | null; body: string | null }[];
  return results.map((comment) => ({ login: comment.user?.login ?? "", body: comment.body ?? "" }));
}

/** Identifies which GitHub login the configured token posts as, so the poll pass can tell "nook already replied" from "a human is waiting on a reply". */
export async function getAuthenticatedLogin(token: string): Promise<string> {
  const response = await fetch(`${GITHUB_API}/user`, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub authenticated-user lookup failed: ${response.status} ${response.statusText}`);
  }
  const user = (await response.json()) as { login: string };
  return user.login;
}

async function createGithubIssue(
  owner: string,
  repo: string,
  token: string,
  title: string,
  body: string,
): Promise<{ number: number; url: string }> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels: [PROPOSED_LABEL] }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`could not create issue: ${response.status} ${response.statusText} ${detail}`);
  }
  const created = (await response.json()) as { number: number; html_url: string };
  return { number: created.number, url: created.html_url };
}

async function addIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  body: string,
): Promise<{ url: string }> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`could not comment on issue #${issueNumber}: ${response.status} ${response.statusText} ${detail}`);
  }
  const created = (await response.json()) as { html_url: string };
  return { url: created.html_url };
}

export const DEFAULT_MAX_ISSUES_PER_RUN = 5;

export function resolveMaxIssuesPerRun(): number {
  const raw = process.env.NOOK_TICKET_MAX_ISSUES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ISSUES_PER_RUN;
}

export interface CreateIssueToolOptions {
  owner: string;
  repo: string;
  token: string;
  maxIssues: number;
  /** Mutated in place so the caller can read how many issues this run actually created once the session ends. */
  createdCount: { current: number };
}

const createIssueParams = Type.Object({
  title: Type.String({ description: "Issue title" }),
  body: Type.String({ description: "Issue body" }),
});

export function createCreateIssueTool(opts: CreateIssueToolOptions): AgentTool<typeof createIssueParams> {
  return {
    name: "create_issue",
    label: "Create issue",
    description: `Open a new GitHub issue labeled '${PROPOSED_LABEL}'. Limited to ${opts.maxIssues} call(s) per run.`,
    parameters: createIssueParams,
    execute: async (_toolCallId, params) => {
      if (opts.createdCount.current >= opts.maxIssues) {
        throw new Error(`reached the limit of ${opts.maxIssues} issue(s) for this run`);
      }
      const created = await createGithubIssue(opts.owner, opts.repo, opts.token, params.title, params.body);
      opts.createdCount.current++;
      return textResult(`created issue #${created.number}: ${created.url}`);
    },
  };
}

export interface ReplyToIssueToolOptions {
  owner: string;
  repo: string;
  token: string;
  /** The one issue this tool is scoped to, fixed at session-creation time — the agent has no way to name a different issue to reply to. */
  issueNumber: number;
}

const replyToIssueParams = Type.Object({ body: Type.String({ description: "Comment body" }) });

export function createReplyToIssueTool(opts: ReplyToIssueToolOptions): AgentTool<typeof replyToIssueParams> {
  return {
    name: "reply_to_issue",
    label: "Reply to issue",
    description: `Post a comment on issue #${opts.issueNumber}. This is the only way to respond — the issue's title and body cannot be edited from here.`,
    parameters: replyToIssueParams,
    execute: async (_toolCallId, params) => {
      const result = await addIssueComment(opts.owner, opts.repo, opts.issueNumber, opts.token, params.body);
      return textResult(`replied on issue #${opts.issueNumber}: ${result.url}`);
    },
  };
}
