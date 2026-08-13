import { expect, test } from "bun:test";

import {
  createConnectionOwnershipArbiter,
  createJobOwnershipConnection,
} from "./job-ownership";

const binding = {
  jobId: "issue-conversation-1",
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

// heartbeat期限は根拠のある運用値が決まるまで固定しない。testが与える。
const heartbeatExpiryMs = 30_000;
const heartbeatStopMs = 10_000;

test("grants Job ownership to one connection at a time and issues an opaque acquisition ID", async () => {
  const arbiter = createConnectionOwnershipArbiter({
    heartbeatExpiryMs,
    now: () => 0,
  });

  const first = await arbiter.acquireJobOwnership({
    jobId: binding.jobId,
    deviceId: "device-1",
  });
  const second = await arbiter.acquireJobOwnership({
    jobId: binding.jobId,
    deviceId: "device-2",
  });

  expect(first).toMatchObject({ status: "acquired" });
  expect(second).toEqual({ status: "rejected", reason: "already_owned" });
});

test("stops the worker and new external operations when a heartbeat is not acknowledged in time", async () => {
  let clock = 0;
  const arbiter = createConnectionOwnershipArbiter({
    heartbeatExpiryMs,
    now: () => clock,
  });
  const connection = createJobOwnershipConnection({
    relay: {
      ...arbiter,
      heartbeat: async () => {
        throw new Error("connection lost");
      },
    },
    jobId: binding.jobId,
    deviceId: "device-1",
    heartbeatStopMs,
    now: () => clock,
  });

  await connection.acquire();
  clock += heartbeatStopMs + 1;

  expect(await connection.sendHeartbeat()).toBe(false);
  expect(connection.stopSignal.aborted).toBe(true);
  expect(
    await connection.hasCurrentJobOwnership({
      ...binding,
      jobLeaseId: connection.jobLeaseId ?? "",
    }),
  ).toBe(false);
});

test("stops the worker and new external operations when the device is revoked", async () => {
  const arbiter = createConnectionOwnershipArbiter({
    heartbeatExpiryMs,
    now: () => 0,
  });
  const connection = createJobOwnershipConnection({
    relay: arbiter,
    jobId: binding.jobId,
    deviceId: "device-1",
    heartbeatStopMs,
    now: () => 0,
  });
  const jobLeaseId = await connection.acquire();

  arbiter.revokeDevice("device-1");

  expect(
    await connection.hasCurrentJobOwnership({
      ...binding,
      jobLeaseId: jobLeaseId ?? "",
    }),
  ).toBe(false);
  expect(connection.stopSignal.aborted).toBe(true);
  expect(
    await arbiter.acquireJobOwnership({
      jobId: binding.jobId,
      deviceId: "device-1",
    }),
  ).toEqual({ status: "rejected", reason: "device_revoked" });
});

test("refuses confirmations and heartbeats from a connection that already expired", async () => {
  let clock = 0;
  const arbiter = createConnectionOwnershipArbiter({
    heartbeatExpiryMs,
    now: () => clock,
  });
  const acquired = await arbiter.acquireJobOwnership({
    jobId: binding.jobId,
    deviceId: "device-1",
  });
  const staleJobLeaseId =
    acquired.status === "acquired" ? acquired.jobLeaseId : "";

  clock += heartbeatExpiryMs + 1;

  expect(await arbiter.heartbeat(staleJobLeaseId)).toBe(false);
  expect(
    await arbiter.confirmJobOwnership({
      jobId: binding.jobId,
      jobLeaseId: staleJobLeaseId,
    }),
  ).toBe(false);
});

test("reconnects with a new acquisition ID and refuses the previous one", async () => {
  let clock = 0;
  const arbiter = createConnectionOwnershipArbiter({
    heartbeatExpiryMs,
    now: () => clock,
  });
  const lost = createJobOwnershipConnection({
    relay: arbiter,
    jobId: binding.jobId,
    deviceId: "device-1",
    heartbeatStopMs,
    now: () => clock,
  });
  const lostJobLeaseId = await lost.acquire();

  clock += heartbeatExpiryMs + 1;
  const reconnected = createJobOwnershipConnection({
    relay: arbiter,
    jobId: binding.jobId,
    deviceId: "device-1",
    heartbeatStopMs,
    now: () => clock,
  });
  const currentJobLeaseId = await reconnected.acquire();

  expect(currentJobLeaseId).not.toBe(lostJobLeaseId);
  expect(
    await reconnected.hasCurrentJobOwnership({
      ...binding,
      jobLeaseId: currentJobLeaseId ?? "",
    }),
  ).toBe(true);
  expect(
    await reconnected.hasCurrentJobOwnership({
      ...binding,
      jobLeaseId: lostJobLeaseId ?? "",
    }),
  ).toBe(false);
  expect(
    await arbiter.confirmJobOwnership({
      jobId: binding.jobId,
      jobLeaseId: lostJobLeaseId ?? "",
    }),
  ).toBe(false);
});

test("releases Job ownership so a replacement connection can acquire it", async () => {
  const arbiter = createConnectionOwnershipArbiter({
    heartbeatExpiryMs,
    now: () => 0,
  });
  const connection = createJobOwnershipConnection({
    relay: arbiter,
    jobId: binding.jobId,
    deviceId: "device-1",
    heartbeatStopMs,
    now: () => 0,
  });
  await connection.acquire();

  await connection.release();

  expect(
    await arbiter.acquireJobOwnership({
      jobId: binding.jobId,
      deviceId: "device-2",
    }),
  ).toMatchObject({ status: "acquired" });
  expect(connection.stopSignal.aborted).toBe(true);
});
