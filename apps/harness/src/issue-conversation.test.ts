import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createIssueCommentApp,
  createIssueCommentOutbox,
} from "../../serve/src/issue-comments";
import {
  createServeIssueCommentOperationClient,
  postIssueConversationReply,
} from "./issue-conversation";

test("an explicitly launched Issue conversation forwards an Agent reply and receives both events", async () => {
  const app = createIssueCommentApp({
    outbox: createIssueCommentOutbox(new Database(":memory:")),
    ownershipVerifier: {
      hasCurrentJobOwnership: () => true,
    },
    publisher: {
      createIssueComment: async () => ({ id: 1234 }),
    },
    newOperationId: () => "operation-1",
  });
  const events: unknown[] = [];
  const operationClient = createServeIssueCommentOperationClient({
    fetch: (input, init) => app.request(input, init),
    origin: "http://127.0.0.1:9999",
  });

  await postIssueConversationReply(
    {
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
    },
    operationClient,
    (event) => events.push(event),
  );

  expect(events).toEqual([
    {
      type: "issue_comment.accepted",
      requestId: "request-1",
      operationId: "operation-1",
    },
    {
      type: "issue_comment.completed",
      requestId: "request-1",
      operationId: "operation-1",
      githubCommentId: 1234,
    },
  ]);
});
