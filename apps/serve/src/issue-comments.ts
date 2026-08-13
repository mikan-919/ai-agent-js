import { randomUUID } from "node:crypto";

import type {
  GitHubRepository,
  IssueCommentAcceptedEvent,
  IssueCommentCompletedEvent,
  IssueCommentEvent,
  IssueCommentReconciliationRequiredEvent,
  IssueCommentRejectedEvent,
  IssueCommentRequest,
} from "@mikan-919/oriel-contracts";
import { Database } from "bun:sqlite";
import type { Octokit } from "@octokit/rest";

export interface JobOwnershipVerifier {
  hasCurrentJobOwnership(input: {
    jobId: string;
    jobLeaseId: string;
    repository: GitHubRepository;
    issueNumber: number;
  }): boolean | Promise<boolean>;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
}

export interface GitHubIssueCommentPublisher {
  createIssueComment(input: {
    repository: GitHubRepository;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
  listIssueComments(input: {
    repository: GitHubRepository;
    issueNumber: number;
  }): Promise<GitHubIssueComment[]>;
  deleteIssueComment(input: {
    repository: GitHubRepository;
    id: number;
  }): Promise<void>;
}

export class GitHubIssueCommentRejectedError extends Error {}

export function createOctokitIssueCommentPublisher(
  octokit: Octokit,
): GitHubIssueCommentPublisher {
  return {
    async createIssueComment({ repository, issueNumber, body }) {
      try {
        const response = await octokit.rest.issues.createComment({
          owner: repository.owner,
          repo: repository.name,
          issue_number: issueNumber,
          body,
        });
        return { id: response.data.id };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          throw new GitHubIssueCommentRejectedError("GitHub rejected comment");
        }

        throw error;
      }
    },
    async listIssueComments({ repository, issueNumber }) {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner: repository.owner,
          repo: repository.name,
          issue_number: issueNumber,
          per_page: 100,
        },
      );

      return comments.map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
      }));
    },
    async deleteIssueComment({ repository, id }) {
      await octokit.rest.issues.deleteComment({
        owner: repository.owner,
        repo: repository.name,
        comment_id: id,
      });
    },
  };
}

type IssueCommentOperationStatus =
  "pending" | "completed" | "rejected" | "reconciliation_required";

export interface IssueCommentOutboxOperation extends IssueCommentRequest {
  operationId: string;
  baselineCommentIds: number[] | null;
  status: IssueCommentOperationStatus;
  githubCommentId: number | null;
}

interface IssueCommentOutboxRow {
  operationId: string;
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  body: string;
  baselineCommentIdsJson: string | null;
  status: IssueCommentOperationStatus;
  githubCommentId: number | null;
}

export function createIssueCommentOutbox(database: Database) {
  const selectOperationSql = `SELECT
      operation_id AS operationId,
      request_id AS requestId,
      job_id AS jobId,
      job_lease_id AS jobLeaseId,
      repository_owner AS repositoryOwner,
      repository_name AS repositoryName,
      issue_number AS issueNumber,
      body,
      baseline_comment_ids_json AS baselineCommentIdsJson,
      status,
      github_comment_id AS githubCommentId
    FROM issue_comment_outbox`;
  const selectOperation = database.query(selectOperationSql);

  return {
    enqueue(operation: IssueCommentOutboxOperation) {
      database
        .query(
          `INSERT INTO issue_comment_outbox (
            operation_id,
            request_id,
            job_id,
            job_lease_id,
            repository_owner,
            repository_name,
            issue_number,
            body,
            baseline_comment_ids_json,
            status,
            github_comment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          operation.requestId,
          operation.jobId,
          operation.jobLeaseId,
          operation.repository.owner,
          operation.repository.name,
          operation.issueNumber,
          operation.body,
          operation.baselineCommentIds === null
            ? null
            : JSON.stringify(operation.baselineCommentIds),
          operation.status,
          operation.githubCommentId,
        );
    },
    find(operationId: string): IssueCommentOutboxOperation | null {
      const row = selectOperation.get(
        operationId,
      ) as IssueCommentOutboxRow | null;

      return row === null ? null : fromRow(row);
    },
    findByRequest(
      jobId: string,
      requestId: string,
    ): IssueCommentOutboxOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE job_id = ? AND request_id = ?`)
        .get(jobId, requestId) as IssueCommentOutboxRow | null;

      return row === null ? null : fromRow(row);
    },
    setBaseline(operationId: string, commentIds: number[]) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET baseline_comment_ids_json = ?
          WHERE operation_id = ?`,
        )
        .run(JSON.stringify(commentIds), operationId);
    },
    complete(operationId: string, githubCommentId: number) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'completed', github_comment_id = ?
          WHERE operation_id = ?`,
        )
        .run(githubCommentId, operationId);
    },
    reject(operationId: string) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'rejected'
          WHERE operation_id = ?`,
        )
        .run(operationId);
    },
    requireReconciliation(operationId: string) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'reconciliation_required'
          WHERE operation_id = ?`,
        )
        .run(operationId);
    },
    pending(): IssueCommentOutboxOperation[] {
      return (selectOperation.all() as IssueCommentOutboxRow[])
        .map(fromRow)
        .filter(
          (operation) =>
            operation.status === "pending" ||
            operation.status === "reconciliation_required",
        );
    },
  };
}

function fromRow(row: IssueCommentOutboxRow): IssueCommentOutboxOperation {
  return {
    type: "issue_comment.request",
    operationId: row.operationId,
    requestId: row.requestId,
    jobId: row.jobId,
    jobLeaseId: row.jobLeaseId,
    repository: {
      owner: row.repositoryOwner,
      name: row.repositoryName,
    },
    issueNumber: row.issueNumber,
    body: row.body,
    baselineCommentIds:
      row.baselineCommentIdsJson === null
        ? null
        : (JSON.parse(row.baselineCommentIdsJson) as number[]),
    status: row.status,
    githubCommentId: row.githubCommentId,
  };
}

type IssueCommentOutbox = ReturnType<typeof createIssueCommentOutbox>;

interface IssueCommentServiceDependencies {
  outbox: IssueCommentOutbox;
  ownershipVerifier: JobOwnershipVerifier;
  publisher: GitHubIssueCommentPublisher;
  newOperationId?: () => string;
}

export function createIssueCommentService({
  outbox,
  ownershipVerifier,
  publisher,
  newOperationId = randomUUID,
}: IssueCommentServiceDependencies) {
  const pendingDeliveries = new Map<string, Promise<void>>();
  const outcomeWaiters = new Map<
    string,
    Array<(event: IssueCommentEvent) => void>
  >();

  async function accept(
    request: IssueCommentRequest,
  ): Promise<IssueCommentAcceptedEvent | IssueCommentRejectedEvent> {
    if (!(await hasCurrentOwnership(request))) {
      return rejected(request.requestId, "ownership_not_current");
    }

    const existing = outbox.findByRequest(request.jobId, request.requestId);

    if (existing !== null) {
      if (!sameRequest(existing, request)) {
        return rejected(request.requestId, "request_conflict");
      }

      void dispatch(existing.operationId);
      return accepted(request.requestId, existing.operationId);
    }

    const operationId = newOperationId();
    const operation: IssueCommentOutboxOperation = {
      ...request,
      operationId,
      baselineCommentIds: null,
      status: "pending",
      githubCommentId: null,
    };

    try {
      outbox.enqueue(operation);
    } catch {
      const racedOperation = outbox.findByRequest(
        request.jobId,
        request.requestId,
      );

      if (racedOperation === null || !sameRequest(racedOperation, request)) {
        throw new Error(
          "Issue-comment outbox operation could not be persisted",
        );
      }

      void dispatch(racedOperation.operationId);
      return accepted(request.requestId, racedOperation.operationId);
    }

    void dispatch(operationId);
    return accepted(request.requestId, operationId);
  }

  async function dispatch(operationId: string): Promise<void> {
    const inFlight = pendingDeliveries.get(operationId);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const delivery = deliver(operationId)
      .catch(() => {
        const operation = outbox.find(operationId);

        if (operation !== null && !isTerminal(operation)) {
          requireReconciliation(operation);
        }
      })
      .finally(() => {
        pendingDeliveries.delete(operationId);
      });
    pendingDeliveries.set(operationId, delivery);
    return delivery;
  }

  async function deliver(operationId: string): Promise<void> {
    const operation = outbox.find(operationId);

    if (operation === null || isTerminal(operation)) {
      return;
    }

    if (operation.status === "reconciliation_required") {
      await reconcile(operation, false);
      return;
    }

    let baselineOperation = operation;

    if (baselineOperation.baselineCommentIds === null) {
      const comments = await publisher.listIssueComments(baselineOperation);
      outbox.setBaseline(
        baselineOperation.operationId,
        comments.map((comment) => comment.id),
      );
      baselineOperation = outbox.find(operationId) ?? baselineOperation;
    }

    if (!(await hasCurrentOwnership(baselineOperation))) {
      finishRejected(baselineOperation, "ownership_not_current");
      return;
    }

    try {
      const comment = await publisher.createIssueComment({
        repository: baselineOperation.repository,
        issueNumber: baselineOperation.issueNumber,
        body: commentBody(baselineOperation),
      });
      outbox.complete(baselineOperation.operationId, comment.id);
      notify(completed(outbox.find(baselineOperation.operationId)!));
    } catch (error) {
      await reconcile(
        baselineOperation,
        error instanceof GitHubIssueCommentRejectedError,
      );
    }
  }

  async function reconcile(
    operation: IssueCommentOutboxOperation,
    definitelyRejected: boolean,
  ): Promise<void> {
    const comments = await publisher.listIssueComments(operation);
    await reconcileComments(operation, comments, definitelyRejected);
  }

  async function reconcileComments(
    operation: IssueCommentOutboxOperation,
    comments: GitHubIssueComment[],
    definitelyRejected: boolean,
  ): Promise<void> {
    const matches = comments
      .filter((comment) => comment.body.includes(operationMarker(operation)))
      .sort((left, right) => left.id - right.id);

    if (matches.length === 0) {
      if (definitelyRejected) {
        finishRejected(operation, "github_rejected");
      } else {
        requireReconciliation(operation);
      }
      return;
    }

    const [canonical, ...duplicates] = matches;

    for (const duplicate of duplicates) {
      if (!(await hasCurrentOwnership(operation))) {
        finishRejected(operation, "ownership_not_current");
        return;
      }

      try {
        await publisher.deleteIssueComment({
          repository: operation.repository,
          id: duplicate.id,
        });
      } catch {
        requireReconciliation(operation);
        return;
      }
    }

    outbox.complete(operation.operationId, canonical.id);
    notify(completed(outbox.find(operation.operationId)!));
  }

  function waitForOutcome(operationId: string): Promise<IssueCommentEvent> {
    const operation = outbox.find(operationId);

    if (operation === null) {
      throw new Error("Issue-comment operation was not found");
    }

    const currentOutcome = outcomeFor(operation);

    if (currentOutcome !== null) {
      return Promise.resolve(currentOutcome);
    }

    return new Promise((resolve) => {
      const waiters = outcomeWaiters.get(operationId) ?? [];
      waiters.push(resolve);
      outcomeWaiters.set(operationId, waiters);
    });
  }

  function notify(event: IssueCommentEvent) {
    if (event.operationId === undefined) {
      return;
    }

    const waiters = outcomeWaiters.get(event.operationId) ?? [];
    outcomeWaiters.delete(event.operationId);

    for (const resolve of waiters) {
      resolve(event);
    }
  }

  function resumePending() {
    for (const operation of outbox.pending()) {
      void resume(operation).catch(() => {
        requireReconciliation(operation);
      });
    }
  }

  async function resume(operation: IssueCommentOutboxOperation): Promise<void> {
    if (operation.status === "reconciliation_required") {
      await reconcile(operation, false);
      return;
    }

    const comments = await publisher.listIssueComments(operation);
    const markerExists = comments.some((comment) =>
      comment.body.includes(operationMarker(operation)),
    );

    if (markerExists) {
      await reconcileComments(operation, comments, false);
      return;
    }

    await dispatch(operation.operationId);
  }

  return { accept, dispatch, resumePending, waitForOutcome };

  async function hasCurrentOwnership(
    operation: Pick<
      IssueCommentRequest,
      "jobId" | "jobLeaseId" | "repository" | "issueNumber"
    >,
  ) {
    return ownershipVerifier.hasCurrentJobOwnership(operation);
  }

  function finishRejected(
    operation: IssueCommentOutboxOperation,
    reason: IssueCommentRejectedEvent["reason"],
  ) {
    outbox.reject(operation.operationId);
    notify(rejected(operation.requestId, reason, operation.operationId));
  }

  function requireReconciliation(operation: IssueCommentOutboxOperation) {
    outbox.requireReconciliation(operation.operationId);
    notify(reconciliationRequired(operation));
  }
}

function sameRequest(
  operation: IssueCommentOutboxOperation,
  request: IssueCommentRequest,
) {
  return (
    operation.jobLeaseId === request.jobLeaseId &&
    operation.repository.owner === request.repository.owner &&
    operation.repository.name === request.repository.name &&
    operation.issueNumber === request.issueNumber &&
    operation.body === request.body
  );
}

function isTerminal(operation: IssueCommentOutboxOperation) {
  return operation.status === "completed" || operation.status === "rejected";
}

function outcomeFor(
  operation: IssueCommentOutboxOperation,
): IssueCommentEvent | null {
  if (operation.status === "completed") {
    return completed(operation);
  }

  if (operation.status === "reconciliation_required") {
    return reconciliationRequired(operation);
  }

  if (operation.status === "rejected") {
    return rejected(
      operation.requestId,
      "github_rejected",
      operation.operationId,
    );
  }

  return null;
}

function accepted(
  requestId: string,
  operationId: string,
): IssueCommentAcceptedEvent {
  return {
    type: "issue_comment.accepted",
    requestId,
    operationId,
  };
}

function completed(
  operation: IssueCommentOutboxOperation,
): IssueCommentCompletedEvent {
  return {
    type: "issue_comment.completed",
    requestId: operation.requestId,
    operationId: operation.operationId,
    githubCommentId: operation.githubCommentId as number,
  };
}

function rejected(
  requestId: string,
  reason: IssueCommentRejectedEvent["reason"],
  operationId?: string,
): IssueCommentRejectedEvent {
  return {
    type: "issue_comment.rejected",
    requestId,
    ...(operationId === undefined ? {} : { operationId }),
    reason,
  };
}

function reconciliationRequired(
  operation: IssueCommentOutboxOperation,
): IssueCommentReconciliationRequiredEvent {
  return {
    type: "issue_comment.reconciliation_required",
    requestId: operation.requestId,
    operationId: operation.operationId,
  };
}

function operationMarker(operation: IssueCommentOutboxOperation) {
  return `<!-- oriel-operation:${operation.operationId} -->`;
}

function commentBody(operation: IssueCommentOutboxOperation) {
  return `${operation.body}\n\n${operationMarker(operation)}`;
}
