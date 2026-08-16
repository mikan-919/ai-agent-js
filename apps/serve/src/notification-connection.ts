import { parseNotificationServerMessage } from "@mikan-919/oriel-contracts";

export interface NotificationConnectionOptions {
  relayOrigin: URL | string;
  /** device bearer tokenをその都度解決する。取れない間は再接続を待つだけにする。 */
  resolveDeviceToken: () => Promise<string | null>;
  onWake: (source: "github" | "linear") => void;
  openWebSocket?: (url: string, deviceToken: string) => WebSocket;
  reconnectDelayMs?: number;
}

export interface NotificationConnection {
  stop(): void;
}

function defaultOpenWebSocket(url: string, deviceToken: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  } as unknown as string[]);
}

/**
 * relayのwebhook起床通知だけを購読する接続。
 *
 * [ADR 0001](../../../docs/adr/0001-distributed-workflow-and-worker-model.md)の
 * とおりwebhookは起床通知に過ぎず、正本ではない。この接続はJob所有権接続
 * (`ownership-connection.ts`)と異なりlease、取得ID、heartbeatを持たない。
 * 欠落・遅延しても定期ポーリングが必ず後追いするため、切断時は固定の短い
 * 遅延で再接続するだけでよい。
 */
export function createNotificationConnection({
  relayOrigin,
  resolveDeviceToken,
  onWake,
  openWebSocket = defaultOpenWebSocket,
  // ponytail: 安全性に無関係な再接続待ち。定期pollが後追いするため測定不要。
  reconnectDelayMs = 5_000,
}: NotificationConnectionOptions): NotificationConnection {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  async function connect() {
    if (stopped) {
      return;
    }

    const deviceToken = await resolveDeviceToken();

    if (deviceToken === null || stopped) {
      scheduleReconnect();
      return;
    }

    const url = new URL("/notifications", relayOrigin);

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    const ws = openWebSocket(url.toString(), deviceToken);

    socket = ws;

    ws.addEventListener("message", (event) => {
      let message;

      try {
        message = parseNotificationServerMessage(
          JSON.parse(String(event.data)) as unknown,
        );
      } catch {
        return;
      }

      if (message.type === "notification.wake") {
        onWake(message.source);
      }
    });

    ws.addEventListener("close", () => {
      if (socket === ws) {
        socket = null;
      }

      scheduleReconnect();
    });
  }

  void connect();

  return {
    stop() {
      stopped = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      socket?.close();
      socket = null;
    },
  };
}
