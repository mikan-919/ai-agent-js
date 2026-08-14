import { expect, test } from "bun:test";

import type { DeviceRegistrationFlow } from "./device-registration";
import { startServeHttpServer } from "./server";

const installationId = 7;
const repositoryId = 11;

function fakeFlow(overrides: Partial<DeviceRegistrationFlow> = {}) {
  const completed: string[] = [];
  const started: Record<string, unknown>[] = [];
  const flow = {
    begin: (input: Record<string, unknown>) => {
      started.push(input);
      return {
        authorizeUrl: new URL(
          `https://relay.test/device/authorize?p=${String(input.purpose)}`,
        ),
      };
    },
    complete: async (callbackUrl: URL | string) => {
      completed.push(String(callbackUrl));
      return { status: "registered" as const, deviceId: "device-1" };
    },
    pendingCancellations: () => [],
    resumePendingCancellations: async () => [],
    ...overrides,
  } as unknown as DeviceRegistrationFlow;

  return { flow, completed, started };
}

function startServer(
  flow: DeviceRegistrationFlow,
  startIssueConversation?: (input: {
    issueNumber: number;
    body: string;
  }) => Promise<{ status: string; reason?: string }>,
) {
  const server = startServeHttpServer({
    createDeviceRegistration: () => flow,
    startIssueConversation,
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

test("the UI starts a fresh GitHub login for listing and for each revocation", async () => {
  const { flow, started } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const post = (body: unknown) =>
      fetch(`${server.origin}/api/device-registrations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify(body),
      });

    expect((await post({ purpose: "installations" })).status).toBe(200);
    expect(
      (
        await post({
          purpose: "device_list",
          installationId,
          repositoryId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          purpose: "revocation",
          installationId,
          repositoryId,
          deviceId: "device-1",
        })
      ).status,
    ).toBe(200);

    // 失効にはdeviceの指定が要る。IDだけの手入力経路は無い。
    expect(
      (await post({ purpose: "revocation", installationId, repositoryId }))
        .status,
    ).toBe(400);
    expect((await post({ purpose: "registration" })).status).toBe(400);
    expect((await post({ purpose: "unknown" })).status).toBe(400);

    expect(started).toEqual([
      {
        purpose: "installations",
        installationId: 0,
        repositoryId: 0,
        deviceId: undefined,
      },
      {
        purpose: "device_list",
        installationId,
        repositoryId,
        deviceId: undefined,
      },
      {
        purpose: "revocation",
        installationId,
        repositoryId,
        deviceId: "device-1",
      },
    ]);
  } finally {
    server.close();
  }
});

test("the shell offers GitHub installation choices instead of typed IDs", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);

    expect(shell.html).toContain("GitHubのinstallation");
    expect(shell.html).toContain('id="targets"');
    expect(shell.html).not.toContain('name="installationId"');
  } finally {
    server.close();
  }
});

test("held cancellations are reported and can be resumed from the localhost UI", async () => {
  const pending = [
    {
      deviceId: "device-1",
      cancellationToken: "cancellation",
      cancellationExpiresAt: 2_000,
    },
  ];
  const { flow } = fakeFlow({
    pendingCancellations: () => pending,
    resumePendingCancellations: async () => pending,
  });
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const listed = await fetch(`${server.origin}/api/device-cancellations`, {
      headers: { Origin: server.origin, cookie: shell.session },
    });

    expect(await listed.json()).toEqual({ pending });

    const resumed = await fetch(
      `${server.origin}/api/device-cancellations/resume`,
      {
        method: "POST",
        headers: {
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
      },
    );

    expect(await resumed.json()).toEqual({ pending });
  } finally {
    server.close();
  }
});

test("the Issue conversation entry takes no Job key or code changing input", async () => {
  const requests: { issueNumber: number; body: string }[] = [];
  const { flow } = fakeFlow();
  const server = startServer(flow, async (input) => {
    requests.push(input);
    return { status: "started" };
  });

  try {
    const shell = await openShell(server.origin);
    const post = (body: unknown) =>
      fetch(`${server.origin}/api/issue-conversations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify(body),
      });

    expect((await post({ issueNumber: 28, body: "reply" })).status).toBe(200);
    // clientはJobキーを指定できず、コードを変更するJobも起動できない。
    expect(
      (await post({ issueNumber: 28, body: "reply", canonicalBranch: "x" }))
        .status,
    ).toBe(400);
    expect((await post({ issueNumber: 28 })).status).toBe(400);
    expect((await post({ issueNumber: 0, body: "reply" })).status).toBe(400);
    expect(requests).toEqual([{ issueNumber: 28, body: "reply" }]);

    const refused = await post({ issueNumber: 29, body: "reply" });

    expect(refused.status).toBe(200);
  } finally {
    server.close();
  }
});

test("a refused conversation answers with a conflict and starts nothing", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow, async () => ({
    status: "refused",
    reason: "github_credentials_unavailable",
  }));

  try {
    const shell = await openShell(server.origin);
    const response = await fetch(`${server.origin}/api/issue-conversations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: server.origin,
        cookie: shell.session,
        "x-oriel-csrf": shell.csrf,
      },
      body: JSON.stringify({ issueNumber: 28, body: "reply" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      status: "refused",
      reason: "github_credentials_unavailable",
    });
  } finally {
    server.close();
  }
});
