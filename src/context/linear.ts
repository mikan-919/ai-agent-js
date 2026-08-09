import type { LinearContext, SourceResult } from "./types";

const LINEAR_API = "https://api.linear.app/graphql";

interface IssueVcsBranchSearchResponse {
  data?: {
    issueVcsBranchSearch: {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      url: string;
      state: { name: string; type: string };
      team: { key: string; name: string };
    } | null;
  };
  errors?: { message: string }[];
}

export async function resolveLinearContext(
  branch: string,
): Promise<SourceResult<LinearContext>> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "LINEAR_API_KEY not set" };
  }

  const query = `
    query($branchName: String!) {
      issueVcsBranchSearch(branchName: $branchName) {
        id
        identifier
        title
        description
        url
        state { name type }
        team { key name }
      }
    }
  `;

  try {
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { branchName: branch } }),
    });
    if (!response.ok) {
      throw new Error(`Linear API request failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as IssueVcsBranchSearchResponse;
    if (json.errors?.length) {
      throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const issue = json.data?.issueVcsBranchSearch;
    if (!issue) {
      return { ok: false, reason: `no Linear issue matched branch '${branch}'` };
    }
    return { ok: true, data: issue };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
