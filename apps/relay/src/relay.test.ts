import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ownershipHeartbeatRequest,
  ownershipHeartbeatResponse,
} from "@mikan-919/oriel-contracts";

import { sha256Base64Url, sha256Hex } from "./crypto";
import type { DeviceRegistryObject } from "./device-registry-object";
import type { RelayGitHubClient } from "./github";
import { createRelayApp } from "./relay";

const installationId = 7;
// testごとに別のrepositoryを使い、Durable Objectを一つのtestだけで共有する。
let nextRepositoryId = 11;
let repository = { id: nextRepositoryId, owner: "mikan-919", name: "oriel" };
const adminCode = "github-oauth-code-admin";
const memberCode = "github-oauth-code-member";
const adminToken = "github-user-token-admin";
const memberToken = "github-user-token-member";
const codeVerifier = "code-verifier-value";
const redirectUri = "http://127.0.0.1:49152/device/callback";
const signingKey = "relay-signing-key";

let currentTime = 1_700_000_000_000;
let administrable = true;
// 生存確認の運用値はtestが与える。既定値は持たない。
let heartbeatExpiryMs = 60_000;

const github: RelayGitHubClient = {
  authorizeUrl: ({ state, redirectUri: callback }) =>
    `https://github.test/login/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(callback)}`,
  exchangeAuthorizationCode: async ({ code }) =>
    code === adminCode ? adminToken : code === memberCode ? memberToken : null,
  getViewer: async (userToken) =>
    userToken === adminToken
      ? { id: 1, login: "admin" }
      : userToken === memberToken
        ? { id: 2, login: "member" }
        : null,
  listInstallations: async () => [{ id: installationId, account: "mikan-919" }],
  listInstallationRepositories: async () => [repository],
  canAdministerInstallation: async ({ userToken }) =>
    administrable && userToken === adminToken,
};

type Purpose = "installations" | "registration" | "device_list" | "revocation";

function relay(overrides: Partial<RelayGitHubClient> = {}) {
  return createRelayApp({
    github: { ...github, ...overrides },
    deviceRegistry: env.DEVICE_REGISTRY,
    signingKey,
    relayOrigin: "https://relay.test",
    codeExpiryMs: 60_000,
    cancellationExpiryMs: 120_000,
    ownershipHeartbeatIntervalMs: 1_000,
    ownershipHeartbeatExpiryMs: heartbeatExpiryMs,
    ownershipAuditIntervalMs: 5_000,
    now: () => currentTime,
  });
}

function registryStub() {
  return env.DEVICE_REGISTRY.get(
    env.DEVICE_REGISTRY.idFromName(`${installationId}/${repository.id}`),
  );
}

async function authorize(
  app: ReturnType<typeof relay>,
  purpose: Purpose,
  state: string,
  deviceId?: string,
) {
  const url = new URL("https://relay.test/device/authorize");
  url.searchParams.set("installation_id", String(installationId));
  url.searchParams.set("repository_id", String(repository.id));
  url.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("purpose", purpose);

  if (deviceId !== undefined) {
    url.searchParams.set("device_id", deviceId);
  }

  return app.fetch(new Request(url));
}

/** GitHub loginを終えてlocalhostへ戻るまでを一度に進める。 */
async function callbackToLocalhost(
  app: ReturnType<typeof relay>,
  purpose: Purpose = "registration",
  oauthCode = adminCode,
  state = "serve-state",
  deviceId?: string,
) {
  const redirect = await authorize(app, purpose, state, deviceId);
  const relayState = new URL(
    redirect.headers.get("location") ?? "",
  ).searchParams.get("state");
  const callbackUrl = new URL("https://relay.test/device/authorize/callback");
  callbackUrl.searchParams.set("code", oauthCode);
  callbackUrl.searchParams.set("state", relayState ?? "");

  return app.fetch(new Request(callbackUrl));
}

function exchangeCode(app: ReturnType<typeof relay>, code: string) {
  return app.fetch(
    new Request("https://relay.test/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    }),
  );
}

async function runOperation(
  app: ReturnType<typeof relay>,
  purpose: Purpose = "registration",
  oauthCode = adminCode,
  state = "serve-state",
  deviceId?: string,
) {
  const callback = await callbackToLocalhost(
    app,
    purpose,
    oauthCode,
    state,
    deviceId,
  );
  const location = new URL(callback.headers.get("location") ?? "");
  const code = location.searchParams.get("code") ?? "";

  return { callback, location, code, response: await exchangeCode(app, code) };
}

async function registerDevice(app: ReturnType<typeof relay>, state: string) {
  const { response } = await runOperation(
    app,
    "registration",
    adminCode,
    state,
  );

  return (await response.json()) as {
    deviceId: string;
    deviceToken: string;
    cancellationToken: string;
  };
}

function openOwnership(
  app: ReturnType<typeof relay>,
  input: {
    deviceToken: string;
    kind: "job" | "branch";
    key: string;
    parentLeaseId?: string;
  },
) {
  const url = new URL("https://relay.test/ownership");
  url.searchParams.set("kind", input.kind);
  url.searchParams.set("key", input.key);

  if (input.parentLeaseId !== undefined) {
    url.searchParams.set("parent_lease_id", input.parentLeaseId);
  }

  return app.fetch(
    new Request(url, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${input.deviceToken}`,
      },
    }),
  );
}

/** 接続直後にrelayが送る受理か拒否、またはheartbeatの応答を読む。 */
function nextMessage(
  socket: WebSocket,
): Promise<Record<string, unknown> | string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const data = String(event.data);

      resolve(
        data.startsWith("{")
          ? (JSON.parse(data) as Record<string, unknown>)
          : data,
      );
    });
    socket.addEventListener("close", () => {
      reject(new Error("closed before a message arrived"));
    });
  });
}

function leaseIdOf(message: Record<string, unknown> | string): string {
  return typeof message === "string" ? "" : String(message.leaseId);
}

beforeEach(() => {
  currentTime = 1_700_000_000_000;
  administrable = true;
  heartbeatExpiryMs = 60_000;
  nextRepositoryId += 1;
  repository = { id: nextRepositoryId, owner: "mikan-919", name: "oriel" };
});

describe("device registration through the relay", () => {
  it("returns only a one-time code and the state to localhost", async () => {
    const callback = await callbackToLocalhost(relay());
    const location = new URL(callback.headers.get("location") ?? "");

    expect(callback.status).toBe(302);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect([...location.searchParams.keys()].sort()).toEqual(["code", "state"]);
  });

  it("refuses a non-loopback redirect target and a plain code challenge", async () => {
    const app = relay();
    const url = new URL("https://relay.test/device/authorize");
    url.searchParams.set("installation_id", String(installationId));
    url.searchParams.set("repository_id", String(repository.id));
    url.searchParams.set("code_challenge", "challenge");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "serve-state");
    url.searchParams.set("redirect_uri", "https://evil.test/device/callback");

    expect((await app.fetch(new Request(url))).status).toBe(400);

    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge_method", "plain");

    expect((await app.fetch(new Request(url))).status).toBe(400);
  });

  it("exchanges the one-time code for a device token bound to the repository", async () => {
    const { response } = await runOperation(relay());
    const body = (await response.json()) as {
      deviceId: string;
      deviceToken: string;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      purpose: "registration",
      installationId,
      repositoryId: repository.id,
    });

    const authenticated = await runInDurableObject(
      registryStub(),
      async (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(await sha256Hex(body.deviceToken)),
    );

    expect(authenticated).toMatchObject({ deviceId: body.deviceId });
  });

  it("consumes the one-time code exactly once even under concurrent exchanges", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const statuses = (
      await Promise.all([exchangeCode(app, code), exchangeCode(app, code)])
    ).map((response) => response.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";

    currentTime += 60_001;

    expect((await exchangeCode(app, code)).status).toBe(400);
  });

  it("keeps the device registry across a Durable Object restart", async () => {
    const registered = await registerDevice(relay(), "serve-state");
    const deviceTokenHash = await sha256Hex(registered.deviceToken);

    // Durable Objectを落として、SQLiteから読み直させる。
    await runInDurableObject(
      registryStub(),
      (_instance: DeviceRegistryObject, state: DurableObjectState) => {
        state.abort("restart for the test");
      },
    ).catch(() => undefined);

    const afterRestart = await runInDurableObject(
      registryStub(),
      (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(deviceTokenHash),
    );

    expect(afterRestart).toMatchObject({ deviceId: registered.deviceId });
  });

  it("lists the installations and repositories the signed-in user can choose", async () => {
    const app = relay();
    const { response } = await runOperation(
      app,
      "installations",
      adminCode,
      "discovery-state",
    );

    expect(await response.json()).toEqual({
      purpose: "installations",
      installations: [
        {
          installationId,
          account: "mikan-919",
          canAdminister: true,
          repositories: [
            {
              repositoryId: repository.id,
              repository: { owner: repository.owner, name: repository.name },
            },
          ],
        },
      ],
    });
  });
});

describe("device revocation through the relay", () => {
  it("checks the current installation administrator on every revocation", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    // 登録できたuserでも、失効時点で管理権限がなければ拒否する。
    const byMember = await callbackToLocalhost(
      app,
      "revocation",
      memberCode,
      "revoke-state",
      registered.deviceId,
    );

    expect(byMember.status).toBe(403);

    administrable = false;

    const afterLosingAdmin = await callbackToLocalhost(
      app,
      "revocation",
      adminCode,
      "revoke-state-2",
      registered.deviceId,
    );

    expect(afterLosingAdmin.status).toBe(403);
    expect(
      await runInDurableObject(registryStub(), async (instance) =>
        instance.authenticateDevice(await sha256Hex(registered.deviceToken)),
      ),
    ).not.toBeNull();

    administrable = true;

    const { response } = await runOperation(
      app,
      "revocation",
      adminCode,
      "revoke-state-3",
      registered.deviceId,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purpose: "revocation",
      deviceId: registered.deviceId,
    });
    expect(
      await runInDurableObject(registryStub(), async (instance) =>
        instance.authenticateDevice(await sha256Hex(registered.deviceToken)),
      ),
    ).toBeNull();
  });

  it("lists devices only for a current installation administrator", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    expect(
      (await callbackToLocalhost(app, "device_list", memberCode, "list-state"))
        .status,
    ).toBe(403);

    const { response } = await runOperation(
      app,
      "device_list",
      adminCode,
      "list-state-2",
    );

    expect(await response.json()).toMatchObject({
      purpose: "device_list",
      devices: [{ deviceId: registered.deviceId, revokedAt: null }],
    });
  });

  it("cancels only the device its proof was issued for", async () => {
    const app = relay();
    const first = await registerDevice(app, "first-state");
    const second = await registerDevice(app, "second-state");
    const cancel = (body: { deviceId: string; cancellationToken: string }) =>
      app.fetch(
        new Request("https://relay.test/device/cancellation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect(
      (
        await cancel({
          deviceId: second.deviceId,
          cancellationToken: first.cancellationToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cancel({
          deviceId: first.deviceId,
          cancellationToken: first.cancellationToken,
        })
      ).status,
    ).toBe(200);
    expect(
      await runInDurableObject(registryStub(), async (instance) =>
        instance.authenticateDevice(await sha256Hex(first.deviceToken)),
      ),
    ).toBeNull();
  });
});

describe("ownership connections on the relay", () => {
  it("grants Job ownership and branch exclusivity to one connection at a time", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const jobSocket = job.webSocket!;

    jobSocket.accept();

    const acquired = await nextMessage(jobSocket);

    expect(job.status).toBe(101);
    expect(acquired).toMatchObject({
      type: "ownership.acquired",
      heartbeatIntervalMs: 1_000,
      heartbeatExpiryMs: 60_000,
    });

    const second = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });

    second.webSocket!.accept();

    expect(await nextMessage(second.webSocket!)).toEqual({
      type: "ownership.rejected",
      reason: "already_owned",
    });

    const branch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/oriel-job-1`,
      parentLeaseId: leaseIdOf(acquired),
    });

    branch.webSocket!.accept();

    expect(await nextMessage(branch.webSocket!)).toMatchObject({
      type: "ownership.acquired",
    });

    const orphanBranch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/other`,
      parentLeaseId: "not-current",
    });

    orphanBranch.webSocket!.accept();

    expect(await nextMessage(orphanBranch.webSocket!)).toEqual({
      type: "ownership.rejected",
      reason: "ownership_not_current",
    });
  });

  it("refuses ownership without a valid device bearer token", async () => {
    const app = relay();

    expect(
      (
        await openOwnership(relay(), {
          deviceToken: `${installationId}.${repository.id}.forged`,
          kind: "job",
          key: "job-1",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request("https://relay.test/ownership?kind=job&key=job-1"),
        )
      ).status,
    ).toBe(426);
  });

  it("invalidates and closes the ownership connections of a revoked device", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const jobSocket = job.webSocket!;

    jobSocket.accept();

    const acquired = await nextMessage(jobSocket);
    const branch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/oriel-job-1`,
      parentLeaseId: leaseIdOf(acquired),
    });

    branch.webSocket!.accept();
    await nextMessage(branch.webSocket!);

    const closedJob = new Promise<number>((resolve) => {
      jobSocket.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    const closedBranch = new Promise<number>((resolve) => {
      branch.webSocket!.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });

    const { response } = await runOperation(
      app,
      "revocation",
      adminCode,
      "revoke-state",
      registered.deviceId,
    );

    expect(response.status).toBe(200);
    expect(await closedJob).toBe(4003);
    expect(await closedBranch).toBe(4003);

    // 失効後は同じdeviceで新しい接続を取れない。
    expect(
      (
        await openOwnership(app, {
          deviceToken: registered.deviceToken,
          kind: "job",
          key: "job-2",
        })
      ).status,
    ).toBe(401);
  });
});

describe("ownership liveness on the relay", () => {
  it("answers the application heartbeat without leaving hibernation", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const socket = job.webSocket!;

    socket.accept();
    await nextMessage(socket);

    const pong = nextMessage(socket);

    socket.send(ownershipHeartbeatRequest);

    // 自動応答なのでwebSocketMessageは呼ばれない。
    expect(await pong).toBe(ownershipHeartbeatResponse);

    const audited = await runInDurableObject(
      registryStub(),
      (_instance: DeviceRegistryObject, state: DurableObjectState) =>
        state
          .getWebSockets()
          .map((ws) => state.getWebSocketAutoResponseTimestamp(ws) !== null),
    );

    expect(audited).toContain(true);
  });

  it("invalidates and closes a connection whose heartbeat expired, on the alarm and on a new acquisition", async () => {
    heartbeatExpiryMs = 0;

    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const stale = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const staleSocket = stale.webSocket!;

    staleSocket.accept();
    await nextMessage(staleSocket);

    const expired = new Promise<{ code: number; message: unknown }>(
      (resolve) => {
        let message: unknown;

        staleSocket.addEventListener("message", (event) => {
          message = JSON.parse(String(event.data));
        });
        staleSocket.addEventListener("close", (event) => {
          resolve({ code: event.code, message });
        });
      },
    );

    // Alarmで最終heartbeatを監査し、期限を過ぎた接続を失効させてから閉じる。
    expect(await runDurableObjectAlarm(registryStub())).toBe(true);
    expect(await expired).toEqual({
      code: 4004,
      message: { type: "ownership.expired" },
    });

    // 失効済み接続は所有権として数えないため、同じキーを取り直せる。
    const replacement = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });

    replacement.webSocket!.accept();

    expect(await nextMessage(replacement.webSocket!)).toMatchObject({
      type: "ownership.acquired",
    });
  });
});
