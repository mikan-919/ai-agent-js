import {
  parseOwnershipServerMessage,
  type OwnershipClientMessage,
} from "@mikan-919/oriel-contracts";

import type { JobOwnershipVerifier } from "./issue-comments";

export interface RelayOwnershipConnectionOptions {
  relayOrigin: URL | string;
  /** device bearer tokenはWebSocket upgradeのAuthorization headerだけへ載せる。 */
  deviceToken: string;
  jobId: string;
  /** client側停止期限。server側失効期限より短い値を運用で与える。 */
  confirmTimeoutMs: number;
  openWebSocket?: (url: string, deviceToken: string) => WebSocket;
}

function defaultOpenWebSocket(url: string, deviceToken: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  } as unknown as string[]);
}

export interface RelayOwnershipConnection extends JobOwnershipVerifier {
  readonly jobLeaseId: string | null;
  readonly branchLeaseId: string | null;
  readonly stopSignal: AbortSignal;
  acquireJobOwnership(): Promise<string | null>;
  acquireBranchExclusivity(branchKey: string): Promise<string | null>;
  release(): void;
}

/**
 * 公開relayの所有権接続。取得IDはrelayだけが発行し、接続が閉じた時点で所有権も消える。
 * 接続を失った、または失効させられた場合は停止合図を出し、`serve`はworkerと
 * 新しい外部操作を止める。
 */
export function createRelayOwnershipConnection({
  relayOrigin,
  deviceToken,
  jobId,
  confirmTimeoutMs,
  openWebSocket = defaultOpenWebSocket,
}: RelayOwnershipConnectionOptions): RelayOwnershipConnection {
  const stopped = new AbortController();
  const sockets: WebSocket[] = [];
  let jobSocket: WebSocket | null = null;
  let jobLeaseId: string | null = null;
  let branchLeaseId: string | null = null;
  let nextRequestId = 0;
  const pendingConfirmations = new Map<string, (current: boolean) => void>();

  function stop() {
    jobLeaseId = null;
    branchLeaseId = null;

    for (const confirm of pendingConfirmations.values()) {
      confirm(false);
    }

    pendingConfirmations.clear();

    if (!stopped.signal.aborted) {
      stopped.abort();
    }

    for (const socket of sockets) {
      socket.close();
    }

    sockets.length = 0;
    jobSocket = null;
  }

  function open(
    kind: "job" | "branch",
    key: string,
    parentLeaseId?: string,
  ): Promise<{ socket: WebSocket; leaseId: string } | null> {
    if (stopped.signal.aborted) {
      return Promise.resolve(null);
    }

    const url = new URL("/ownership", relayOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("kind", kind);
    url.searchParams.set("key", key);

    if (parentLeaseId !== undefined) {
      url.searchParams.set("parent_lease_id", parentLeaseId);
    }

    const socket = openWebSocket(url.toString(), deviceToken);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: { socket: WebSocket; leaseId: string } | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      socket.addEventListener("message", (event) => {
        let message;

        try {
          message = parseOwnershipServerMessage(
            JSON.parse(String(event.data)) as unknown,
          );
        } catch {
          return;
        }

        if (message.type === "ownership.acquired") {
          sockets.push(socket);
          settle({ socket, leaseId: message.leaseId });
          return;
        }

        if (message.type === "ownership.confirmed") {
          pendingConfirmations.get(message.requestId)?.(message.current);
          pendingConfirmations.delete(message.requestId);
          return;
        }

        // 失効通知と拒否では所有権を持たない。
        settle(null);

        if (message.type === "ownership.revoked") {
          stop();
        }
      });

      // 切断も確認不能も同じ扱いとして停止する。
      socket.addEventListener("close", () => {
        settle(null);

        if (sockets.includes(socket)) {
          stop();
        }
      });
      socket.addEventListener("error", () => {
        settle(null);
      });
    });
  }

  function send(socket: WebSocket, message: OwnershipClientMessage) {
    socket.send(JSON.stringify(message));
  }

  return {
    get jobLeaseId() {
      return jobLeaseId;
    },
    get branchLeaseId() {
      return branchLeaseId;
    },
    stopSignal: stopped.signal,
    async acquireJobOwnership() {
      const acquired = await open("job", jobId);
      jobLeaseId = acquired?.leaseId ?? null;
      jobSocket = acquired?.socket ?? null;

      return jobLeaseId;
    },
    async acquireBranchExclusivity(branchKey) {
      if (jobLeaseId === null) {
        return null;
      }

      const acquired = await open("branch", branchKey, jobLeaseId);
      branchLeaseId = acquired?.leaseId ?? null;

      return branchLeaseId;
    },
    /** 外部操作の直前に、同じ所有権接続で現在の取得IDを確認する。 */
    async hasCurrentJobOwnership(request) {
      const socket = jobSocket;

      if (
        stopped.signal.aborted ||
        socket === null ||
        jobLeaseId === null ||
        request.jobId !== jobId ||
        request.jobLeaseId !== jobLeaseId
      ) {
        return false;
      }

      const requestId = `confirm-${(nextRequestId += 1)}`;
      const confirmed = new Promise<boolean>((resolve) => {
        pendingConfirmations.set(requestId, resolve);
        setTimeout(() => {
          if (pendingConfirmations.delete(requestId)) {
            // 期限内に確認できなければ、切断通知を待たず停止する。
            stop();
            resolve(false);
          }
        }, confirmTimeoutMs).unref?.();
      });

      send(socket, {
        type: "ownership.confirm",
        requestId,
        leaseId: jobLeaseId,
      });

      return confirmed;
    },
    release() {
      stop();
    },
  };
}
