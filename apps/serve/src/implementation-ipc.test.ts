import { expect, test } from "bun:test";

import type {
  CheckpointRequest,
  ImplementationStartEvent,
} from "@mikan-919/oriel-contracts";

import { serveOwnedHarnessImplementationIpc } from "./implementation-ipc";

const digest = "a".repeat(64);
const sealedOid = "1".repeat(40);
const headOid = "2".repeat(40);

const start: ImplementationStartEvent = {
  type: "implementation.start",
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  approvalFingerprint: digest,
  canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
  canonicalOid: sealedOid,
  worktreePath: "/worktrees/job",
  adopted: false,
  what: { title: "WHAT title", body: "WHAT body" },
  how: { title: "HOW title", description: "HOW description" },
  verification: [["bun", "test"]],
};

const checkpoint: CheckpointRequest = {
  type: "checkpoint.request",
  requestId: "checkpoint-1",
  jobId: start.jobId,
  jobLeaseId: start.jobLeaseId,
  branchLeaseId: start.branchLeaseId,
  approvalFingerprint: digest,
  canonicalBranch: start.canonicalBranch,
  expectedOid: sealedOid,
  headOid,
  verified: true,
};

function harnessStdout(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }

      controller.close();
    },
  });
}

function serveStdin() {
  const written: unknown[] = [];
  const decoder = new TextDecoder();

  return {
    written,
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line !== "") {
            written.push(JSON.parse(line));
          }
        }
      },
    }),
  };
}

function fakeService(
  outcome: "completed" | "rejected" = "completed",
  acceptance: "accepted" | "rejected" = "accepted",
) {
  const accepted: CheckpointRequest[] = [];
  const delivered: string[] = [];

  return {
    accepted,
    delivered,
    service: {
      accept: async (request: CheckpointRequest) => {
        accepted.push(request);

        return acceptance === "accepted"
          ? ({
              type: "checkpoint.accepted",
              requestId: request.requestId,
              operationId: "operation-1",
            } as const)
          : ({
              type: "checkpoint.rejected",
              requestId: request.requestId,
              reason: "ownership_not_current",
            } as const);
      },
      deliver: async (operationId: string) => {
        delivered.push(operationId);

        return outcome === "completed"
          ? ({
              type: "checkpoint.completed",
              requestId: "checkpoint-1",
              operationId,
              canonicalOid: headOid,
            } as const)
          : ({
              type: "checkpoint.rejected",
              requestId: "checkpoint-1",
              reason: "remote_diverged",
            } as const);
      },
    },
  };
}

test("the harness is started with the sealed worktree and answered per checkpoint", async () => {
  const stdin = serveStdin();
  const { service, accepted, delivered } = fakeService();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([checkpoint]),
    stdin.stream,
    start,
    service,
  );

  expect(accepted).toEqual([checkpoint]);
  expect(delivered).toEqual(["operation-1"]);
  expect(stdin.written).toEqual([
    start,
    {
      type: "checkpoint.accepted",
      requestId: "checkpoint-1",
      operationId: "operation-1",
    },
    {
      type: "checkpoint.completed",
      requestId: "checkpoint-1",
      operationId: "operation-1",
      canonicalOid: headOid,
    },
  ]);
});

test("a refused checkpoint is answered once and never delivered", async () => {
  const stdin = serveStdin();
  const { service, delivered } = fakeService("completed", "rejected");

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([checkpoint]),
    stdin.stream,
    start,
    service,
  );

  expect(delivered).toEqual([]);
  expect(stdin.written.slice(1)).toEqual([
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "ownership_not_current",
    },
  ]);
});

test("a malformed or credential bearing request is refused without reaching the service", async () => {
  const stdin = serveStdin();
  const { service, accepted } = fakeService();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([
      { type: "checkpoint.request", requestId: "checkpoint-9" },
      { ...checkpoint, installationToken: "must-not-cross-the-boundary" },
    ]),
    stdin.stream,
    start,
    service,
  );

  expect(accepted).toEqual([]);
  expect(stdin.written.slice(1)).toEqual([
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-9",
      reason: "invalid_request",
    },
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "invalid_request",
    },
  ]);
});

test("losing ownership closes the request path before the harness is served", async () => {
  const stdin = serveStdin();
  const { service, accepted } = fakeService();
  const lost = new AbortController();

  lost.abort();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([checkpoint]),
    stdin.stream,
    start,
    service,
    lost.signal,
  );

  expect(accepted).toEqual([]);
  expect(stdin.written).toEqual([start]);
});
