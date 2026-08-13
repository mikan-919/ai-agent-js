import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

import {
  createIssueCommentApp,
  createIssueCommentOutbox,
  createOctokitIssueCommentPublisher,
} from "./issue-comments";

test("accepts a valid owned Issue-comment request and persists its outbox operation", async () => {
  const outbox = createIssueCommentOutbox(new Database(":memory:"));
  const app = createIssueCommentApp({
    outbox,
    ownershipVerifier: {
      hasCurrentJobOwnership: () => true,
    },
    publisher: {
      createIssueComment: () => new Promise(() => {}),
    },
    newOperationId: () => "operation-1",
  });

  const response = await app.request("/v1/harness/issue-comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "issue_comment.request",
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
    }),
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    type: "issue_comment.accepted",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(outbox.find("operation-1")).toMatchObject({
    operationId: "operation-1",
    requestId: "request-1",
    status: "pending",
  });
});

test("keeps an accepted Issue-comment operation in SQLite after the serve process restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-comment-"));
  const databasePath = join(directory, "serve.sqlite");
  const firstDatabase = new Database(databasePath);
  const firstOutbox = createIssueCommentOutbox(firstDatabase);

  try {
    firstOutbox.enqueue({
      type: "issue_comment.request",
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
      operationId: "operation-1",
      status: "pending",
      githubCommentId: null,
    });
    firstDatabase.close();

    const secondDatabase = new Database(databasePath);
    const restartedOutbox = createIssueCommentOutbox(secondDatabase);

    expect(restartedOutbox.find("operation-1")).toMatchObject({
      operationId: "operation-1",
      requestId: "request-1",
      status: "pending",
    });
    secondDatabase.close();
  } finally {
    firstDatabase.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects a request whose Issue-conversation ownership is no longer current", async () => {
  const outbox = createIssueCommentOutbox(new Database(":memory:"));
  const checkedOwnerships: unknown[] = [];
  let publicationAttempted = false;
  const app = createIssueCommentApp({
    outbox,
    ownershipVerifier: {
      hasCurrentJobOwnership: (input) => {
        checkedOwnerships.push(input);
        return false;
      },
    },
    publisher: {
      createIssueComment: async () => {
        publicationAttempted = true;
        return { id: 1234 };
      },
    },
    newOperationId: () => "operation-1",
  });

  const response = await app.request("/v1/harness/issue-comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "issue_comment.request",
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "expired-lease",
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
    }),
  });

  expect(response.status).toBe(403);
  expect(checkedOwnerships).toEqual([
    {
      jobId: "issue-conversation-1",
      jobLeaseId: "expired-lease",
      repository: "mikan-919/oriel",
      issueNumber: 28,
    },
  ]);
  expect(outbox.find("operation-1")).toBeNull();
  expect(publicationAttempted).toBe(false);
});

test("rejects an invalid harness request before checking ownership or storing an operation", async () => {
  const outbox = createIssueCommentOutbox(new Database(":memory:"));
  let ownershipChecked = false;
  const app = createIssueCommentApp({
    outbox,
    ownershipVerifier: {
      hasCurrentJobOwnership: () => {
        ownershipChecked = true;
        return true;
      },
    },
    publisher: {
      createIssueComment: async () => ({ id: 1234 }),
    },
    newOperationId: () => "operation-1",
  });

  const response = await app.request("/v1/harness/issue-comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "issue_comment.request",
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
      githubToken: "must-not-cross-the-boundary",
    }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Invalid issue-comment request",
  });
  expect(ownershipChecked).toBe(false);
  expect(outbox.find("operation-1")).toBeNull();
});

test("delivers the GitHub comment result to the harness after acceptance", async () => {
  const result = Promise.withResolvers<{ id: number }>();
  const published: Array<{
    repository: string;
    issueNumber: number;
    body: string;
  }> = [];
  const outbox = createIssueCommentOutbox(new Database(":memory:"));
  const app = createIssueCommentApp({
    outbox,
    ownershipVerifier: {
      hasCurrentJobOwnership: () => true,
    },
    publisher: {
      createIssueComment: (input) => {
        published.push(input);
        return result.promise;
      },
    },
    newOperationId: () => "operation-1",
  });

  const acceptedResponse = await app.request("/v1/harness/issue-comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "issue_comment.request",
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
    }),
  });

  expect(acceptedResponse.status).toBe(202);
  const completedResponse = Promise.resolve(
    app.request("/v1/harness/operations/operation-1"),
  );
  let completionDelivered = false;
  void completedResponse.then(() => {
    completionDelivered = true;
  });

  await Promise.resolve();
  expect(completionDelivered).toBe(false);
  expect(published).toEqual([
    {
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
    },
  ]);

  result.resolve({ id: 1234 });
  const completed = await completedResponse;

  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
});

test("uses the trusted serve GitHub client to create the selected Issue comment", async () => {
  let receivedInput: unknown;
  const publisher = createOctokitIssueCommentPublisher({
    rest: {
      issues: {
        createComment: async (input: unknown) => {
          receivedInput = input;
          return { data: { id: 1234 } };
        },
      },
    },
  } as unknown as Octokit);

  await expect(
    publisher.createIssueComment({
      repository: "mikan-919/oriel",
      issueNumber: 28,
      body: "Agent reply",
    }),
  ).resolves.toEqual({ id: 1234 });
  expect(receivedInput).toEqual({
    owner: "mikan-919",
    repo: "oriel",
    issue_number: 28,
    body: "Agent reply",
  });
});
