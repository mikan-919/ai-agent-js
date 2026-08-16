import { expect, test } from "bun:test";

import { createNotificationConnection } from "./notification-connection";

/** 通知チャンネルだけを持つrelayのfake。wire protocolは`packages/contracts`と共有する。 */
function startFakeNotificationRelay(deviceToken = "7.11.device-token") {
  const authorizationHeaders: string[] = [];
  let upgrades = 0;
  const sockets = new Set<import("bun").ServerWebSocket<undefined>>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";

      authorizationHeaders.push(authorization);

      if (
        url.pathname !== "/notifications" ||
        authorization !== `Bearer ${deviceToken}`
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      upgrades += 1;

      return bunServer.upgrade(request)
        ? undefined
        : new Response("Upgrade Required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message() {
        // 通知clientは通常messageを送らない。
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizationHeaders: () => authorizationHeaders,
    upgrades: () => upgrades,
    broadcastWake(source: "github" | "linear") {
      for (const ws of sockets) {
        ws.send(JSON.stringify({ type: "notification.wake", source }));
      }
    },
    sendRaw(raw: string) {
      for (const ws of sockets) {
        ws.send(raw);
      }
    },
    closeAll() {
      for (const ws of sockets) {
        ws.close();
      }
    },
    stop: () => server.stop(true),
  };
}

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }

      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }

      setTimeout(poll, 5);
    };

    poll();
  });
}

test("calls onWake with the source of a received wake message", async () => {
  const relay = startFakeNotificationRelay();
  const wakes: ("github" | "linear")[] = [];
  const connection = createNotificationConnection({
    relayOrigin: relay.origin,
    resolveDeviceToken: async () => "7.11.device-token",
    onWake: (source) => wakes.push(source),
  });

  try {
    await waitFor(() => relay.upgrades() === 1);
    relay.broadcastWake("github");
    await waitFor(() => wakes.length === 1);

    expect(wakes).toEqual(["github"]);
  } finally {
    connection.stop();
    relay.stop();
  }
});

test("ignores malformed or schema-invalid messages without throwing", async () => {
  const relay = startFakeNotificationRelay();
  const wakes: string[] = [];
  const connection = createNotificationConnection({
    relayOrigin: relay.origin,
    resolveDeviceToken: async () => "7.11.device-token",
    onWake: (source) => wakes.push(source),
  });

  try {
    await waitFor(() => relay.upgrades() === 1);
    relay.sendRaw("not json");
    relay.sendRaw(
      JSON.stringify({ type: "notification.wake", source: "slack" }),
    );
    relay.sendRaw(JSON.stringify({ type: "something.else" }));

    // 有効なwakeが最初のメッセージとして観測できることで、上のmessageたちが
    // 例外を投げずに黙って無視されたことを確認する。
    relay.broadcastWake("linear");
    await waitFor(() => wakes.length === 1);

    expect(wakes).toEqual(["linear"]);
  } finally {
    connection.stop();
    relay.stop();
  }
});

test("reconnects after the connection closes", async () => {
  const relay = startFakeNotificationRelay();
  const connection = createNotificationConnection({
    relayOrigin: relay.origin,
    resolveDeviceToken: async () => "7.11.device-token",
    onWake: () => undefined,
    reconnectDelayMs: 10,
  });

  try {
    await waitFor(() => relay.upgrades() === 1);
    relay.closeAll();
    await waitFor(() => relay.upgrades() === 2);
  } finally {
    connection.stop();
    relay.stop();
  }
});

test("stopping the connection does not trigger a reconnect", async () => {
  const relay = startFakeNotificationRelay();
  const connection = createNotificationConnection({
    relayOrigin: relay.origin,
    resolveDeviceToken: async () => "7.11.device-token",
    onWake: () => undefined,
    reconnectDelayMs: 10,
  });

  await waitFor(() => relay.upgrades() === 1);
  connection.stop();

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(relay.upgrades()).toBe(1);
  relay.stop();
});

test("sends the device token as a bearer token exactly once", async () => {
  const relay = startFakeNotificationRelay();
  const connection = createNotificationConnection({
    relayOrigin: relay.origin,
    resolveDeviceToken: async () => "7.11.device-token",
    onWake: () => undefined,
  });

  try {
    await waitFor(() => relay.upgrades() === 1);

    expect(relay.authorizationHeaders()).toEqual(["Bearer 7.11.device-token"]);
  } finally {
    connection.stop();
    relay.stop();
  }
});
