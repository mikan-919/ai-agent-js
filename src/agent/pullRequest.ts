import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PullRequestOutcome } from "./types";

const GITHUB_API = "https://api.github.com";

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "nook",
  };
}

interface GithubPullRequest {
  number: number;
  html_url: string;
}

async function findOpenPullRequest(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<GithubPullRequest | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub pulls lookup failed: ${response.status} ${response.statusText}`);
  }
  const results = (await response.json()) as GithubPullRequest[];
  return results[0] ?? null;
}

async function createPullRequest(
  owner: string,
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  token: string,
): Promise<GithubPullRequest> {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, head: branch, base }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`could not create pull request: ${response.status} ${response.statusText} ${detail}`);
  }
  return (await response.json()) as GithubPullRequest;
}

/**
 * Pushes via a short-lived GIT_ASKPASS script rather than a token embedded
 * in the remote URL or a `-c` flag, so the token doesn't show up in `ps`
 * output for the git subprocess.
 */
async function pushBranch(cwd: string, branch: string, token: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "nook-askpass-"));
  const scriptPath = join(dir, "askpass.sh");
  try {
    await writeFile(scriptPath, '#!/bin/sh\necho "$NOOK_GIT_TOKEN"\n', { mode: 0o700 });
    await $`git -C ${cwd} push origin HEAD:refs/heads/${branch}`.env({
      ...process.env,
      GIT_ASKPASS: scriptPath,
      NOOK_GIT_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface CreatePullRequestToolOptions {
  cwd: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  token: string;
  /** Called once the tool has actually pushed and opened/found a PR, so the caller (POST /agent/run) can report it. */
  onResult: (outcome: PullRequestOutcome) => void;
}

/**
 * Splits commit-then-push-and-open-PR across the bash tool and this tool
 * (per the agreed design): the agent commits locally via bash (no
 * credentials needed for that), then calls this tool, which pushes and
 * opens/updates the PR using GITHUB_TOKEN — a credential the agent itself
 * never sees (CONCEPT.md principle 2).
 */
const createPullRequestParams = Type.Object({
  title: Type.String({ description: "Pull request title" }),
  body: Type.String({ description: "Pull request body" }),
});

export function createPullRequestTool(opts: CreatePullRequestToolOptions): AgentTool<typeof createPullRequestParams> {
  return {
    name: "create_pull_request",
    label: "Create pull request",
    description:
      "Push the current branch and open (or reuse) a pull request against the base branch. Commit your changes with the bash tool first — this tool does not commit.",
    parameters: createPullRequestParams,
    execute: async (_toolCallId, params) => {
      await pushBranch(opts.cwd, opts.branch, opts.token);

      const existing = await findOpenPullRequest(opts.owner, opts.repo, opts.branch, opts.token);
      const outcome: PullRequestOutcome = existing
        ? { url: existing.html_url, number: existing.number, created: false }
        : await (async () => {
            const created = await createPullRequest(
              opts.owner,
              opts.repo,
              opts.branch,
              opts.baseBranch,
              params.title,
              params.body,
              opts.token,
            );
            return { url: created.html_url, number: created.number, created: true };
          })();

      opts.onResult(outcome);
      return {
        content: [
          {
            type: "text",
            text: outcome.created
              ? `opened PR #${outcome.number}: ${outcome.url}`
              : `pushed to existing PR #${outcome.number}: ${outcome.url}`,
          },
        ],
        details: {},
      };
    },
  };
}
