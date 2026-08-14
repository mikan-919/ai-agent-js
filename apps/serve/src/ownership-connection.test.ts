import { expect, test } from "bun:test";

import { startFakeOwnershipRelay } from "./ownership-relay.fake";
import { createRelayOwnershipConnection } from "./ownership-connection";

const deviceToken = "7.11.device-token";
const jobId = "issue-conversation-1";
const binding = {
  jobId,
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

function connect(relayOrigin: string, token = deviceToken, stopMs = 1_000) {
  return createRelayOwnershipConnection({
    relayOrigin,
    deviceToken: token,
    jobId,
    heartbeatStopMs: stopMs,
  });
}

test("Job ownership and branch exclusivity are acquired over the relay connection", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin);

  try {
    const jobLeaseId = await connection.acquireJobOwnership();

    expect(jobLeaseId).toEqual(expect.any(String));
    expect(relay.authorizationHeaders()).toEqual([`Bearer ${deviceToken}`]);

    const branchLeaseId =
      await connection.acquireBranchExclusivity("11/oriel-job-1");

    expect(branchLeaseId).toEqual(expect.any(String));
    expect(
      await connection.hasCurrentJobOwnership({
        ...binding,
        jobLeaseId: jobLeaseId ?? "",
      }),
    ).toBe(true);
    expect(
      await connection.hasCurrentJobOwnership({
        ...binding,
        jobLeaseId: "not-current",
      }),
    ).toBe(false);
  } finally {
    connection.release();
    relay.stop();
  }
});

test("a second connection cannot take the same Job, and a branch needs a current Job lease", async () => {
  const relay = startFakeOwnershipRelay();
  const first = connect(relay.origin);
  const second = connect(relay.origin);
  const detached = connect(relay.origin);

  try {
    expect(await first.acquireJobOwnership()).toEqual(expect.any(String));
    expect(await second.acquireJobOwnership()).toBeNull();
    expect(
      await detached.acquireBranchExclusivity("11/oriel-job-1"),
    ).toBeNull();
  } finally {
    first.release();
    second.release();
    detached.release();
    relay.stop();
  }
});

test("a revoked device loses both connections and stops the worker", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin);

  try {
    const jobLeaseId = await connection.acquireJobOwnership();

    await connection.acquireBranchExclusivity("11/oriel-job-1");

    expect(connection.stopSignal.aborted).toBe(false);

    relay.revokeDevice();

    await Bun.sleep(50);

    expect(connection.stopSignal.aborted).toBe(true);
    expect(relay.openConnections()).toBe(0);
    expect(
      await connection.hasCurrentJobOwnership({
        ...binding,
        jobLeaseId: jobLeaseId ?? "",
      }),
    ).toBe(false);
  } finally {
    connection.release();
    relay.stop();
  }
});

test("an unauthenticated device gets no ownership", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin, "7.11.forged");

  try {
    expect(await connection.acquireJobOwnership()).toBeNull();
  } finally {
    connection.release();
    relay.stop();
  }
});

test("the connection heartbeats and stops when the relay stops answering", async () => {
  const relay = startFakeOwnershipRelay("7.11.device-token", {
    heartbeatIntervalMs: 10,
    heartbeatExpiryMs: 60_000,
  });
  const connection = connect(relay.origin, deviceToken, 50);

  try {
    expect(await connection.acquireJobOwnership()).toEqual(expect.any(String));

    await Bun.sleep(60);

    expect(relay.heartbeats()).toBeGreaterThan(0);
    expect(connection.stopSignal.aborted).toBe(false);

    relay.stopAnsweringHeartbeats();
    await Bun.sleep(150);

    // 応答を停止期限内に受け取れないので、切断通知を待たず止まる。
    expect(connection.stopSignal.aborted).toBe(true);
  } finally {
    connection.release();
    relay.stop();
  }
});

test("a client stop deadline that is not shorter than the relay expiry takes no ownership", async () => {
  const relay = startFakeOwnershipRelay("7.11.device-token", {
    heartbeatIntervalMs: 10,
    heartbeatExpiryMs: 1_000,
  });
  const connection = connect(relay.origin, deviceToken, 1_000);

  try {
    expect(await connection.acquireJobOwnership()).toBeNull();
    expect(connection.stopSignal.aborted).toBe(true);
  } finally {
    connection.release();
    relay.stop();
  }
});
