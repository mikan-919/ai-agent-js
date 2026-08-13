import {
  type IssueCommentAcceptedEvent,
  type IssueCommentCompletedEvent,
  type IssueCommentRequest,
  parseIssueCommentAcceptedEvent,
  parseIssueCommentCompletedEvent,
} from "@mikan-919/oriel-contracts";

export interface IssueCommentOperationClient {
  requestIssueComment(
    request: IssueCommentRequest,
  ): Promise<IssueCommentAcceptedEvent>;
  waitForIssueCommentCompletion(
    operationId: string,
  ): Promise<IssueCommentCompletedEvent>;
}

interface ServeIssueCommentOperationClientDependencies {
  fetch: (input: string, init?: RequestInit) => Response | Promise<Response>;
  origin: string;
}

export function createServeIssueCommentOperationClient({
  fetch,
  origin,
}: ServeIssueCommentOperationClientDependencies): IssueCommentOperationClient {
  return {
    async requestIssueComment(request) {
      const response = await fetch(
        new URL("/v1/harness/issue-comments", origin).toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );

      if (response.status !== 202) {
        throw new Error(
          `Issue-comment operation was rejected: ${response.status}`,
        );
      }

      const event: unknown = await response.json();
      return parseIssueCommentAcceptedEvent(event);
    },
    async waitForIssueCommentCompletion(operationId) {
      const response = await fetch(
        new URL(`/v1/harness/operations/${operationId}`, origin).toString(),
      );

      if (response.status !== 200) {
        throw new Error(
          `Issue-comment operation did not complete: ${response.status}`,
        );
      }

      const event: unknown = await response.json();
      return parseIssueCommentCompletedEvent(event);
    },
  };
}

export interface IssueConversationReply {
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  repository: string;
  issueNumber: number;
  body: string;
}

export async function postIssueConversationReply(
  reply: IssueConversationReply,
  operationClient: IssueCommentOperationClient,
  onEvent: (
    event: IssueCommentAcceptedEvent | IssueCommentCompletedEvent,
  ) => void,
) {
  const accepted = await operationClient.requestIssueComment({
    type: "issue_comment.request",
    ...reply,
  });
  onEvent(accepted);

  const completed = await operationClient.waitForIssueCommentCompletion(
    accepted.operationId,
  );

  if (
    completed.requestId !== reply.requestId ||
    completed.operationId !== accepted.operationId
  ) {
    throw new Error(
      "Issue-comment completion did not match the accepted operation",
    );
  }

  onEvent(completed);
}
