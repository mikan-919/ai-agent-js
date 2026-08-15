import { identity } from "@mikan-919/oriel-identity";

import type { LinearApprovalReader } from "./github-approval-ports";

const linearApi = "https://api.linear.app/graphql";
const issueQuery = `query($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { name }
    attachments(first: 100) { nodes { url } }
  }
}`;

export interface LinearApprovalReaderOptions {
  /** Linear OAuth token。`serve`だけが持ち、harnessへは渡さない。 */
  token: string;
  fetchImpl?: (request: Request) => Promise<Response>;
}

/**
 * HOWと実行承認の現在値を読む境界。承認指紋の計算に必要な現在値だけを返し、
 * 本文をローカルの正本として保存しない。読めない、曖昧、能力不足はnullにして
 * fail closedにする。
 */
export function createLinearApprovalReader({
  token,
  fetchImpl = (request) => fetch(request),
}: LinearApprovalReaderOptions): LinearApprovalReader {
  return {
    async readIssue(linearIssueId) {
      let payload;

      try {
        const response = await fetchImpl(
          new Request(linearApi, {
            method: "POST",
            headers: {
              // tokenはheaderだけへ載せる。
              authorization: token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              query: issueQuery,
              variables: { id: linearIssueId },
            }),
          }),
        );

        if (!response.ok) {
          return null;
        }

        payload = (await response.json()) as {
          data?: {
            issue?: {
              id?: string;
              identifier?: string;
              title?: string;
              description?: string | null;
              state?: { name?: string } | null;
              attachments?: { nodes?: { url?: string }[] } | null;
            } | null;
          };
          errors?: unknown[];
        };
      } catch {
        return null;
      }

      const issue = payload.data?.issue;

      if (
        (payload.errors ?? []).length > 0 ||
        issue?.id === undefined ||
        issue.identifier === undefined ||
        issue.title === undefined ||
        issue.state?.name === undefined
      ) {
        return null;
      }

      return {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        stateName: issue.state.name,
        attachmentUrls: (issue.attachments?.nodes ?? []).map(
          (node) => node.url ?? "",
        ),
      };
    },
  };
}

/** Linear tokenの保存先。Secret Serviceを使えない場合はfail closedにする。 */
export function bunSecretsLinearToken(repositoryId: number) {
  return {
    async get(): Promise<string | null> {
      try {
        return (
          (await Bun.secrets.get({
            service: identity.codeName,
            name: `linear-token:${repositoryId}`,
          })) ?? null
        );
      } catch {
        return null;
      }
    },
  };
}
