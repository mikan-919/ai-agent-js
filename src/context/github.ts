import { $ } from "bun";
import type { GithubContext, GithubIssueRef, SourceResult } from "./types";

const GITHUB_API = "https://api.github.com";

export interface OwnerRepo {
  owner: string;
  repo: string;
}

export async function getOwnerRepo(repoPath: string): Promise<OwnerRepo | null> {
  let remoteUrl: string;
  try {
    remoteUrl = (await $`git -C ${repoPath} remote get-url origin`.text()).trim();
  } catch {
    return null;
  }
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}

interface GithubPullRequestListItem {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  html_url: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

async function findPullRequestForBranch(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<GithubPullRequestListItem | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nook",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub pulls lookup failed: ${response.status} ${response.statusText}`);
  }
  const results = (await response.json()) as GithubPullRequestListItem[];
  return results[0] ?? null;
}

interface ClosingIssuesGraphqlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        closingIssuesReferences?: {
          nodes: { number: number; title: string; state: string; url: string }[];
        };
      };
    };
  };
  errors?: { message: string }[];
}

async function findLinkedIssues(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<GithubIssueRef[]> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 10) {
            nodes { number title state url }
          }
        }
      }
    }
  `;
  const response = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "nook",
    },
    body: JSON.stringify({ query, variables: { owner, repo, number: pullNumber } }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as ClosingIssuesGraphqlResponse;
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const nodes = json.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
  return nodes;
}

export async function resolveGithubContext(
  repoPath: string,
  branch: string,
): Promise<SourceResult<GithubContext>> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, reason: "GITHUB_TOKEN not set" };
  }

  const ownerRepo = await getOwnerRepo(repoPath);
  if (!ownerRepo) {
    return { ok: false, reason: "could not determine owner/repo from git remote 'origin'" };
  }
  const { owner, repo } = ownerRepo;

  try {
    const pr = await findPullRequestForBranch(owner, repo, branch, token);
    if (!pr) {
      return { ok: true, data: { owner, repo, pullRequest: null, linkedIssues: [] } };
    }

    const linkedIssues = await findLinkedIssues(owner, repo, pr.number, token);

    return {
      ok: true,
      data: {
        owner,
        repo,
        pullRequest: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          isDraft: pr.draft,
          url: pr.html_url,
          body: pr.body,
          headRefName: pr.head.ref,
          baseRefName: pr.base.ref,
        },
        linkedIssues,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
