import { expect, test } from "bun:test";

import {
  parseCheckpointRequest,
  parseImplementationClientMessage,
  parseImplementationServerMessage,
  type CheckpointRequest,
  type ImplementationStartEvent,
} from "./index";

const digest = "a".repeat(64);
const oid = "1".repeat(40);

const start = {
  type: "implementation.start",
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  approvalFingerprint: digest,
  canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
  canonicalOid: oid,
  worktreePath: "/home/serve/worktrees/implementation-11-28",
  worktreeOid: oid,
  adopted: false,
  model: { provider: "lm-studio", id: "local-model" },
  what: { title: "WHAT title", body: "WHAT body" },
  how: { title: "HOW title", description: "HOW description" },
  verification: [
    ["bun", "run", "typecheck"],
    ["bun", "test"],
  ],
} satisfies ImplementationStartEvent;

const checkpoint = {
  type: "checkpoint.request",
  requestId: "checkpoint-1",
  jobId: start.jobId,
  jobLeaseId: start.jobLeaseId,
  branchLeaseId: start.branchLeaseId,
  approvalFingerprint: digest,
  canonicalBranch: start.canonicalBranch,
  expectedOid: oid,
  headOid: "2".repeat(40),
  verified: true,
} satisfies CheckpointRequest;

test("the sealed worktree and the approved WHAT/HOW reach the harness without credentials", () => {
  expect(parseImplementationServerMessage(start)).toEqual(start);

  // credentialはenv、argv、tool入力だけでなく、IPCのstart eventへも載せない。
  expect(() =>
    parseImplementationServerMessage({
      ...start,
      installationToken: "must-not-cross-the-boundary",
    }),
  ).toThrow();
});

test("a checkpoint request carries the acquisition IDs and the comparison condition", () => {
  expect(parseCheckpointRequest(checkpoint)).toEqual(checkpoint);
  expect(parseImplementationClientMessage(checkpoint)).toEqual(checkpoint);

  // 送信前OIDと送る先端はGitのobject IDでなければならない。
  expect(() =>
    parseCheckpointRequest({ ...checkpoint, expectedOid: "HEAD~1" }),
  ).toThrow();
  expect(() =>
    parseCheckpointRequest({ ...checkpoint, headOid: "A".repeat(40) }),
  ).toThrow();
  // 取得IDを省いた要求は受け付けない。
  expect(() =>
    parseCheckpointRequest({ ...checkpoint, branchLeaseId: "" }),
  ).toThrow();
});

test("the checkpoint outcome events are part of the server messages", () => {
  const completed = {
    type: "checkpoint.completed" as const,
    requestId: "checkpoint-1",
    operationId: "operation-1",
    canonicalOid: "2".repeat(40),
  };
  const rejected = {
    type: "checkpoint.rejected" as const,
    requestId: "checkpoint-1",
    reason: "remote_diverged" as const,
  };

  expect(parseImplementationServerMessage(completed)).toEqual(completed);
  expect(parseImplementationServerMessage(rejected)).toEqual(rejected);
  expect(() =>
    parseImplementationServerMessage({
      ...rejected,
      reason: "not_a_known_reason",
    }),
  ).toThrow();
});
