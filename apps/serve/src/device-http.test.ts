import { expect, test } from "bun:test";

import type { DeviceRegistrationFlow } from "./device-registration";
import { startServeHttpServer } from "./server";

const installationId = 7;
const repositoryId = 11;

function fakeFlow(overrides: Partial<DeviceRegistrationFlow> = {}) {
  const completed: string[] = [];
  const revoked: string[] = [];
  const flow = {
    begin: ({ purpose = "registration" }) => ({
      authorizeUrl: new URL(`https://relay.test/device/authorize?p=${purpose}`),
    }),
    complete: async (callbackUrl: URL | string) => {
      completed.push(String(callbackUrl));
      return { status: "registered" as const, deviceId: "device-1" };
    },
    pendingCancellations: () => [],
    retryPendingCancellations: async () => [],
    hasManagementSession: () => true,
    listDevices: async () => [],
    revokeDevice: async (deviceId: string) => {
      revoked.push(deviceId);
      return true;
    },
    ...overrides,
  } as unknown as DeviceRegistrationFlow;

  return { flow, completed, revoked };
}

function startServer(flow: DeviceRegistrationFlow) {
  const server = startServeHttpServer({
    createDeviceRegistration: () => flow,
  });

  return {
    ...server,
    origin: new URL(server.readinessUrl).origin,
    close: () => server.server.stop(true),
  };
}

async function openShell(origin: string) {
  const response = await fetch(`${origin}/`, { headers: { Origin: origin } });
  const html = await response.text();
  const cookie = response.headers.get("set-cookie") ?? "";

  return {
    response,
    html,
    cookie,
    session: cookie.split(";")[0] ?? "",
    csrf: /content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

test("the localhost shell sets a per-start session cookie and hands out a CSRF token", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);

    expect(shell.response.status).toBe(200);
    expect(shell.cookie).toContain("HttpOnly");
    expect(shell.cookie).toContain("SameSite=Strict");
    expect(shell.cookie).toContain("Path=/");
    expect(shell.cookie).not.toContain("Max-Age");
    expect(shell.cookie).not.toContain("Expires");
    expect(shell.csrf).not.toBe("");
    expect(
      shell.response.headers.get("access-control-allow-origin"),
    ).toBeNull();
    expect(shell.response.headers.get("x-frame-options")).toBe("DENY");
  } finally {
    server.close();
  }
});

test("state changing requests need the session cookie, the CSRF header, and a same-origin Origin", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const body = JSON.stringify({
      purpose: "registration",
      installationId,
      repositoryId,
    });
    const post = (headers: Record<string, string>) =>
      fetch(`${server.origin}/api/device-registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });

    expect((await post({ Origin: server.origin })).status).toBe(403);
    expect(
      (await post({ Origin: server.origin, cookie: shell.session })).status,
    ).toBe(403);
    expect(
      (
        await post({
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": "forged",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post({
          Origin: "http://forged.invalid",
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        })
      ).status,
    ).toBe(400);

    const accepted = await post({
      Origin: server.origin,
      cookie: shell.session,
      "x-oriel-csrf": shell.csrf,
    });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      authorizeUrl: "https://relay.test/device/authorize?p=registration",
    });
  } finally {
    server.close();
  }
});

test("the relay callback is a plain GET that changes nothing until the UI posts it back", async () => {
  const { flow, completed } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const callback = await fetch(
      `${server.origin}/device/callback?code=one-time&state=state-1`,
      { headers: { Origin: server.origin } },
    );

    expect(callback.status).toBe(200);
    expect(completed).toEqual([]);

    const completion = await fetch(
      `${server.origin}/api/device-registrations/completion`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify({ code: "one-time", state: "state-1" }),
      },
    );

    expect(completion.status).toBe(200);
    expect(await completion.json()).toEqual({
      status: "registered",
      deviceId: "device-1",
    });
    expect(completed).toHaveLength(1);
    expect(new URL(completed[0] ?? "").searchParams.get("code")).toBe(
      "one-time",
    );
  } finally {
    server.close();
  }
});

test("devices are listed and revoked only through the localhost UI with a management session", async () => {
  const { flow, revoked } = fakeFlow({
    listDevices: async () => [
      {
        deviceId: "device-1",
        installationId,
        repositoryId,
        repository: { owner: "mikan-919", name: "oriel" },
        registeredAt: 1_000,
        revokedAt: null,
      },
    ],
  });
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const listed = await fetch(`${server.origin}/api/devices`, {
      headers: { Origin: server.origin, cookie: shell.session },
    });

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      devices: [{ deviceId: "device-1" }],
    });

    const revocation = await fetch(
      `${server.origin}/api/devices/device-1/revocation`,
      {
        method: "POST",
        headers: {
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
      },
    );

    expect(revocation.status).toBe(200);
    expect(revoked).toEqual(["device-1"]);
  } finally {
    server.close();
  }
});

test("management actions are refused without a current management session", async () => {
  const { flow } = fakeFlow({
    hasManagementSession: () => false,
    listDevices: async () => null,
    revokeDevice: async () => false,
  });
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);

    expect(
      (
        await fetch(`${server.origin}/api/devices`, {
          headers: { Origin: server.origin, cookie: shell.session },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${server.origin}/api/devices/device-1/revocation`, {
          method: "POST",
          headers: {
            Origin: server.origin,
            cookie: shell.session,
            "x-oriel-csrf": shell.csrf,
          },
        })
      ).status,
    ).toBe(409);
  } finally {
    server.close();
  }
});
