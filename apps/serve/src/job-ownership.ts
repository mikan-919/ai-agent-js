import { randomUUID } from "node:crypto";

import type { JobOwnershipVerifier } from "./issue-comments";

export type JobOwnershipAcquisition =
  | { status: "acquired"; jobLeaseId: string }
  | { status: "rejected"; reason: "already_owned" | "device_revoked" };

/**
 * 公開リレーが接続所有権へ提供する最小の操作。取得IDはリレーだけが発行する。
 */
export interface ConnectionOwnershipRelay {
  acquireJobOwnership(input: {
    jobId: string;
    deviceId: string;
    /** リレー側が接続を失効させた後に閉じる合図。 */
    onClosed?: () => void;
  }): JobOwnershipAcquisition | Promise<JobOwnershipAcquisition>;
  heartbeat(jobLeaseId: string): boolean | Promise<boolean>;
  confirmJobOwnership(input: {
    jobId: string;
    jobLeaseId: string;
  }): boolean | Promise<boolean>;
  releaseJobOwnership(jobLeaseId: string): void | Promise<void>;
}

export interface ConnectionOwnershipArbiter extends ConnectionOwnershipRelay {
  revokeDevice(deviceId: string): void;
}

interface JobOwnershipConnectionRecord {
  jobId: string;
  deviceId: string;
  lastHeartbeatAt: number;
  onClosed?: () => void;
}

export interface ConnectionOwnershipArbiterOptions {
  /** server側失効期限。運用値は測定と検証専用環境から決めるため既定値を持たない。 */
  heartbeatExpiryMs: number;
  now?: () => number;
  newJobLeaseId?: () => string;
}

/**
 * ADR 0004/0005のJob所有権調停。接続付随情報だけを持ち、所有権recordも履歴も残さない。
 *
 * ponytail: リレーのDurable Objectがまだ無いため、WebSocketではなく同じ判断を持つ
 * in-processの調停として置く。relay appを作る時にこの関数をDO側へ移す。
 */
export function createConnectionOwnershipArbiter({
  heartbeatExpiryMs,
  now = Date.now,
  newJobLeaseId = randomUUID,
}: ConnectionOwnershipArbiterOptions): ConnectionOwnershipArbiter {
  const connections = new Map<string, JobOwnershipConnectionRecord>();
  const revokedDevices = new Set<string>();

  function expireStaleConnections() {
    const deadline = now() - heartbeatExpiryMs;

    for (const [jobLeaseId, connection] of connections) {
      if (
        connection.lastHeartbeatAt < deadline ||
        revokedDevices.has(connection.deviceId)
      ) {
        // 接続付随情報を失効させてから閉じる。閉じた後の確認は取得ID不一致になる。
        connections.delete(jobLeaseId);
        connection.onClosed?.();
      }
    }
  }

  function current(jobLeaseId: string) {
    expireStaleConnections();
    return connections.get(jobLeaseId) ?? null;
  }

  return {
    acquireJobOwnership({ jobId, deviceId, onClosed }) {
      expireStaleConnections();

      if (revokedDevices.has(deviceId)) {
        return { status: "rejected", reason: "device_revoked" };
      }

      for (const connection of connections.values()) {
        if (connection.jobId === jobId) {
          return { status: "rejected", reason: "already_owned" };
        }
      }

      const jobLeaseId = newJobLeaseId();
      connections.set(jobLeaseId, {
        jobId,
        deviceId,
        lastHeartbeatAt: now(),
        onClosed,
      });

      return { status: "acquired", jobLeaseId };
    },
    heartbeat(jobLeaseId) {
      const connection = current(jobLeaseId);

      if (connection === null) {
        return false;
      }

      connection.lastHeartbeatAt = now();
      return true;
    },
    confirmJobOwnership({ jobId, jobLeaseId }) {
      return current(jobLeaseId)?.jobId === jobId;
    },
    releaseJobOwnership(jobLeaseId) {
      connections.delete(jobLeaseId);
    },
    revokeDevice(deviceId) {
      revokedDevices.add(deviceId);
      expireStaleConnections();
    },
  };
}

export interface JobOwnershipConnectionOptions {
  relay: ConnectionOwnershipRelay;
  jobId: string;
  deviceId: string;
  /** client側停止期限。server側失効期限より短い値を運用で与える。 */
  heartbeatStopMs: number;
  now?: () => number;
}

export interface JobOwnershipConnection extends JobOwnershipVerifier {
  readonly jobLeaseId: string | null;
  readonly stopSignal: AbortSignal;
  acquire(): Promise<string | null>;
  sendHeartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * `serve`側の所有権接続。停止した接続は再利用せず、再接続は新しい接続と取得IDで行う。
 */
export function createJobOwnershipConnection({
  relay,
  jobId,
  deviceId,
  heartbeatStopMs,
  now = Date.now,
}: JobOwnershipConnectionOptions): JobOwnershipConnection {
  const stopped = new AbortController();
  let jobLeaseId: string | null = null;
  let lastAcknowledgedAt = 0;

  function stop() {
    jobLeaseId = null;

    if (!stopped.signal.aborted) {
      stopped.abort();
    }

    return false;
  }

  return {
    get jobLeaseId() {
      return jobLeaseId;
    },
    stopSignal: stopped.signal,
    async acquire() {
      if (stopped.signal.aborted) {
        return null;
      }

      const acquisition = await relay.acquireJobOwnership({ jobId, deviceId });

      if (acquisition.status === "rejected") {
        return null;
      }

      jobLeaseId = acquisition.jobLeaseId;
      lastAcknowledgedAt = now();
      return jobLeaseId;
    },
    async sendHeartbeat() {
      if (jobLeaseId === null) {
        return stop();
      }

      const acknowledged = await Promise.resolve(
        relay.heartbeat(jobLeaseId),
      ).catch(() => false);

      if (acknowledged) {
        lastAcknowledgedAt = now();
        return true;
      }

      // 応答を受け取れないまま停止期限を過ぎたら、切断通知を待たず停止する。
      return now() - lastAcknowledgedAt > heartbeatStopMs ? stop() : false;
    },
    async hasCurrentJobOwnership(request) {
      if (
        stopped.signal.aborted ||
        jobLeaseId === null ||
        request.jobId !== jobId ||
        request.jobLeaseId !== jobLeaseId
      ) {
        return false;
      }

      if (now() - lastAcknowledgedAt > heartbeatStopMs) {
        return stop();
      }

      const confirmed = await Promise.resolve(
        relay.confirmJobOwnership({ jobId, jobLeaseId }),
      ).catch(() => false);

      return confirmed ? true : stop();
    },
    async release() {
      if (jobLeaseId !== null) {
        await relay.releaseJobOwnership(jobLeaseId);
      }

      stop();
    },
  };
}
