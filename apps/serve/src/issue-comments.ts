import { randomUUID } from "node:crypto";

import { sValidator } from "@hono/standard-validator";
import {
  type IssueCommentAcceptedEvent,
  type IssueCommentCompletedEvent,
  type IssueCommentRequest,
  issueCommentRequestSchema,
} from "@mikan-919/oriel-contracts";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Octokit } from "@octokit/rest";

export interface JobOwnershipVerifier {
  hasCurrentJobOwnership(input: {
    jobId: string;
    jobLeaseId: string;
    repository: string;
    issueNumber: number;
  }): boolean | Promise<boolean>;
}

export interface GitHubIssueCommentPublisher {
  createIssueComment(input: {
    repository: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
}

export function createOctokitIssueCommentPublisher(
  octokit: Octokit,
): GitHubIssueCommentPublisher {
  return {
    async createIssueComment({ repository, issueNumber, body }) {
      const [owner, repo, extraPath] = repository.split("/");

      if (
        owner === undefined ||
        repo === undefined ||
        extraPath !== undefined
      ) {
        throw new Error("Issue-comment repository must be an owner/name pair");
      }

      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return { id: response.data.id };
    },
  };
}

export interface IssueCommentOutboxOperation extends IssueCommentRequest {
  operationId: string;
  status: "pending" | "completed";
  githubCommentId: number | null;
}

export function createIssueCommentOutbox(database: Database) {
  const completionWaiters = new Map<
    string,
    Array<(operation: IssueCommentOutboxOperation) => void>
  >();

  database.exec(`
    CREATE TABLE IF NOT EXISTS issue_comment_outbox (
      operation_id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      job_lease_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      github_comment_id INTEGER
    )
  `);

  return {
    enqueue(operation: IssueCommentOutboxOperation) {
      database
        .query(
          `INSERT INTO issue_comment_outbox (
            operation_id,
            request_id,
            job_id,
            job_lease_id,
            repository,
            issue_number,
            body,
            status,
            github_comment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          operation.requestId,
          operation.jobId,
          operation.jobLeaseId,
          operation.repository,
          operation.issueNumber,
          operation.body,
          operation.status,
          operation.githubCommentId,
        );
    },
    find(operationId: string): IssueCommentOutboxOperation | null {
      const row = database
        .query(
          `SELECT
            operation_id AS operationId,
            request_id AS requestId,
            job_id AS jobId,
            job_lease_id AS jobLeaseId,
            repository,
            issue_number AS issueNumber,
            body,
            status,
            github_comment_id AS githubCommentId
          FROM issue_comment_outbox
          WHERE operation_id = ?`,
        )
        .get(operationId) as IssueCommentOutboxOperation | null;

      return row;
    },
    complete(operationId: string, githubCommentId: number) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'completed', github_comment_id = ?
          WHERE operation_id = ?`,
        )
        .run(githubCommentId, operationId);

      const completed = this.find(operationId);

      if (completed === null) {
        return;
      }

      const waiters = completionWaiters.get(operationId) ?? [];
      completionWaiters.delete(operationId);

      for (const resolve of waiters) {
        resolve(completed);
      }
    },
    waitForCompletion(
      operationId: string,
    ): Promise<IssueCommentOutboxOperation | null> {
      const operation = this.find(operationId);

      if (operation === null || operation.status === "completed") {
        return Promise.resolve(operation);
      }

      return new Promise((resolve) => {
        const waiters = completionWaiters.get(operationId) ?? [];
        waiters.push(resolve);
        completionWaiters.set(operationId, waiters);
      });
    },
  };
}

type IssueCommentOutbox = ReturnType<typeof createIssueCommentOutbox>;

interface IssueCommentAppDependencies {
  outbox: IssueCommentOutbox;
  ownershipVerifier: JobOwnershipVerifier;
  publisher: GitHubIssueCommentPublisher;
  newOperationId?: () => string;
}

export function createIssueCommentApp({
  outbox,
  ownershipVerifier,
  publisher,
  newOperationId = randomUUID,
}: IssueCommentAppDependencies) {
  const app = new Hono();

  app.post(
    "/v1/harness/issue-comments",
    sValidator("json", issueCommentRequestSchema, (result, context) => {
      if (!result.success) {
        return context.json({ error: "Invalid issue-comment request" }, 400);
      }
    }),
    async (context) => {
      const request = context.req.valid("json");
      const ownsJob = await ownershipVerifier.hasCurrentJobOwnership({
        jobId: request.jobId,
        jobLeaseId: request.jobLeaseId,
        repository: request.repository,
        issueNumber: request.issueNumber,
      });

      if (!ownsJob) {
        return context.json({ error: "Job ownership is not current" }, 403);
      }

      const operationId = newOperationId();
      const operation: IssueCommentOutboxOperation = {
        ...request,
        operationId,
        status: "pending",
        githubCommentId: null,
      };
      outbox.enqueue(operation);

      void deliverIssueComment(operation, outbox, publisher);

      const accepted: IssueCommentAcceptedEvent = {
        type: "issue_comment.accepted",
        requestId: request.requestId,
        operationId,
      };
      return context.json(accepted, 202);
    },
  );

  app.get("/v1/harness/operations/:operationId", async (context) => {
    const operation = await outbox.waitForCompletion(
      context.req.param("operationId"),
    );

    if (operation === null) {
      return context.json({ error: "Operation was not found" }, 404);
    }

    const completed: IssueCommentCompletedEvent = {
      type: "issue_comment.completed",
      requestId: operation.requestId,
      operationId: operation.operationId,
      githubCommentId: operation.githubCommentId as number,
    };
    return context.json(completed);
  });

  return app;
}

async function deliverIssueComment(
  operation: IssueCommentOutboxOperation,
  outbox: IssueCommentOutbox,
  publisher: GitHubIssueCommentPublisher,
) {
  try {
    const comment = await publisher.createIssueComment({
      repository: operation.repository,
      issueNumber: operation.issueNumber,
      body: `${operation.body}\n\n<!-- oriel-operation:${operation.operationId} -->`,
    });
    outbox.complete(operation.operationId, comment.id);
  } catch {
    // A pending operation is reconciled by the trusted serve process after restart.
  }
}
