import { randomUUID } from "node:crypto";

import {
  ownershipHeartbeatRequest,
  ownershipHeartbeatResponse,
  parseOwnershipClientMessage,
} from "@mikan-919/oriel-contracts";

interface OwnershipConnectionData {
  kind: "job" | "branch";
  key: string;
  leaseId: string;
  parentLeaseId: string | null;
  valid: boolean;
}

/**
 * 所有権接続だけを持つrelayのfake。wire protocolは`packages/contracts`と共有し、
 * relay本体はworkerd上のvitestで検証する。
 */
export function startFakeOwnershipRelay(
  deviceToken = "7.11.device-token",
  liveness = { heartbeatIntervalMs: 20, heartbeatExpiryMs: 60_000 },
) {
  let heartbeats = 0;
  let answersHeartbeats = true;
  const authorizationHeaders: string[] = [];
  const connections = new Map<
    { data: OwnershipConnectionData },
    OwnershipConnectionData
  >();

  const server = Bun.serve<OwnershipConnectionData, "/ownership">({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";

      authorizationHeaders.push(authorization);

      if (
        url.pathname !== "/ownership" ||
        authorization !== `Bearer ${deviceToken}`
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const kind = url.searchParams.get("kind") === "branch" ? "branch" : "job";
      const key = url.searchParams.get("key") ?? "";
      const parentLeaseId = url.searchParams.get("parent_lease_id");

      const data: OwnershipConnectionData = {
        kind,
        key,
        leaseId: randomUUID(),
        parentLeaseId,
        valid: true,
      };

      return bunServer.upgrade(request, { data })
        ? undefined
        : new Response("Upgrade Required", { status: 426 });
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        const active = [...connections.values()].filter(
          (connection) => connection.valid,
        );

        if (
          data.kind === "branch" &&
          !active.some(
            (connection) =>
              connection.kind === "job" &&
              connection.leaseId === data.parentLeaseId,
          )
        ) {
          ws.send(
            JSON.stringify({
              type: "ownership.rejected",
              reason: "ownership_not_current",
            }),
          );
          ws.close(4001, "ownership_not_current");
          return;
        }

        if (
          active.some(
            (connection) =>
              connection.kind === data.kind && connection.key === data.key,
          )
        ) {
          ws.send(
            JSON.stringify({
              type: "ownership.rejected",
              reason: "already_owned",
            }),
          );
          ws.close(4001, "already_owned");
          return;
        }

        connections.set(ws as never, data);
        ws.send(
          JSON.stringify({
            type: "ownership.acquired",
            leaseId: data.leaseId,
            heartbeatIntervalMs: liveness.heartbeatIntervalMs,
            heartbeatExpiryMs: liveness.heartbeatExpiryMs,
          }),
        );
      },
      message(ws, message) {
        if (String(message) === ownershipHeartbeatRequest) {
          heartbeats += 1;

          if (answersHeartbeats) {
            ws.send(ownershipHeartbeatResponse);
          }

          return;
        }

        const request = parseOwnershipClientMessage(
          JSON.parse(String(message)) as unknown,
        );
        const data = connections.get(ws as never);

        ws.send(
          JSON.stringify({
            type: "ownership.confirmed",
            requestId: request.requestId,
            current: data?.valid === true && data.leaseId === request.leaseId,
          }),
        );
      },
      close(ws) {
        connections.delete(ws as never);
      },
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizationHeaders: () => authorizationHeaders,
    openConnections: () => connections.size,
    heartbeats: () => heartbeats,
    /** half-open接続として、応答だけを止める。 */
    stopAnsweringHeartbeats: () => {
      answersHeartbeats = false;
    },
    /** 登録簿の失効と同じ順序で、接続を失効させてから閉じる。 */
    revokeDevice() {
      for (const [ws, data] of connections) {
        data.valid = false;
        (ws as unknown as WebSocket).send(
          JSON.stringify({ type: "ownership.revoked" }),
        );
        (ws as unknown as { close(code: number, reason: string): void }).close(
          4003,
          "device revoked",
        );
      }

      connections.clear();
    },
    stop: () => server.stop(true),
  };
}
