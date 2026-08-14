import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

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
  listInstallationRepositories: async () => [repository],
  canAdministerInstallation: async ({ userToken }) => userToken === adminToken,
};

function relay(overrides: Partial<RelayGitHubClient> = {}) {
  return createRelayApp({
    github: { ...github, ...overrides },
    deviceRegistry: env.DEVICE_REGISTRY,
    signingKey,
    relayOrigin: "https://relay.test",
    codeExpiryMs: 60_000,
    managementSessionExpiryMs: 300_000,
    cancellationExpiryMs: 120_000,
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
  purpose: "registration" | "management" = "registration",
  state = "serve-state",
) {
  const url = new URL("https://relay.test/device/authorize");
  url.searchParams.set("installation_id", String(installationId));
  url.searchParams.set("repository_id", String(repository.id));
  url.searchParams.set(
    "code_challenge",
    await sha256Base64Url(codeVerifier + purpose + state),
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("purpose", purpose);

  return app.fetch(new Request(url));
}

/** GitHub loginを終えてlocalhostへ戻るまでを一度に進める。 */
async function callbackToLocalhost(
  app: ReturnType<typeof relay>,
  purpose: "registration" | "management" = "registration",
  oauthCode = adminCode,
  state = "serve-state",
) {
  const redirect = await authorize(app, purpose, state);
  const relayState = new URL(
    redirect.headers.get("location") ?? "",
  ).searchParams.get("state");
  const callbackUrl = new URL("https://relay.test/device/authorize/callback");
  callbackUrl.searchParams.set("code", oauthCode);
  callbackUrl.searchParams.set("state", relayState ?? "");

  return app.fetch(new Request(callbackUrl));
}

async function exchange(
  app: ReturnType<typeof relay>,
  purpose: "registration" | "management" = "registration",
  oauthCode = adminCode,
  state = "serve-state",
) {
  const callback = await callbackToLocalhost(app, purpose, oauthCode, state);
  const location = new URL(callback.headers.get("location") ?? "");
  const code = location.searchParams.get("code") ?? "";

  const response = await app.fetch(
    new Request("https://relay.test/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        codeVerifier: codeVerifier + purpose + state,
      }),
    }),
  );

  return { response, code, location };
}

beforeEach(() => {
  currentTime = 1_700_000_000_000;
  nextRepositoryId += 1;
  repository = { id: nextRepositoryId, owner: "mikan-919", name: "oriel" };
});

describe("device registration through the relay", () => {
  it("sends the browser to GitHub login and keeps no state of its own", async () => {
    const response = await authorize(relay());
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(302);
    expect(location.origin).toBe("https://github.test");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("state")).not.toContain(codeVerifier);
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

  it("returns only a one-time code and the state to localhost", async () => {
    const callback = await callbackToLocalhost(relay());
    const location = new URL(callback.headers.get("location") ?? "");

    expect(callback.status).toBe(302);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect([...location.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(location.searchParams.get("state")).toBe("serve-state");
  });

  it("exchanges the one-time code for a device token bound to the repository", async () => {
    const { response } = await exchange(relay());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      purpose: "registration",
      installationId,
      repositoryId: repository.id,
      repository: { owner: repository.owner, name: repository.name },
    });

    const deviceTokenHash = await sha256Hex(
      (body as { deviceToken: string }).deviceToken,
    );
    const authenticated = await runInDurableObject(
      registryStub(),
      (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(deviceTokenHash),
    );

    expect(authenticated).toMatchObject({
      deviceId: (body as { deviceId: string }).deviceId,
      repositoryId: repository.id,
    });
  });

  it("consumes the one-time code exactly once even under concurrent exchanges", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const request = () =>
      app.fetch(
        new Request("https://relay.test/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code,
            codeVerifier: codeVerifier + "registration" + "serve-state",
          }),
        }),
      );

    const statuses = (await Promise.all([request(), request()])).map(
      (response) => response.status,
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(1);
  });

  it("refuses a mismatched verifier and burns the code", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const post = (verifier: string) =>
      app.fetch(
        new Request("https://relay.test/device/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, codeVerifier: verifier }),
        }),
      );

    expect((await post("wrong-verifier")).status).toBe(400);
    expect(
      (await post(codeVerifier + "registration" + "serve-state")).status,
    ).toBe(400);
  });

  it("refuses an expired code", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";

    currentTime += 60_001;

    const response = await app.fetch(
      new Request("https://relay.test/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          codeVerifier: codeVerifier + "registration" + "serve-state",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("keeps the device registry across a Durable Object restart", async () => {
    const { response } = await exchange(relay());
    const body = (await response.json()) as {
      deviceId: string;
      deviceToken: string;
    };
    const deviceTokenHash = await sha256Hex(body.deviceToken);

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

    expect(afterRestart).toMatchObject({ deviceId: body.deviceId });
  });
});

describe("device management through the relay", () => {
  it("issues a management session only to a current installation administrator", async () => {
    const app = relay();
    const memberCallback = await callbackToLocalhost(
      app,
      "management",
      memberCode,
    );

    expect(memberCallback.status).toBe(403);

    const { response } = await exchange(app, "management");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purpose: "management",
      installationId,
      repositoryId: repository.id,
    });
  });

  it("lists and revokes devices with a management session only", async () => {
    const app = relay();
    const registered = (await (await exchange(app)).response.json()) as {
      deviceId: string;
      deviceToken: string;
    };
    const management = (await (
      await exchange(app, "management", adminCode, "management-state")
    ).response.json()) as { managementToken: string };
    const authorized = {
      authorization: `Bearer ${management.managementToken}`,
    };

    expect(
      (await app.fetch(new Request("https://relay.test/devices"))).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request("https://relay.test/devices", {
            headers: { authorization: "Bearer forged" },
          }),
        )
      ).status,
    ).toBe(401);

    const listed = await app.fetch(
      new Request("https://relay.test/devices", { headers: authorized }),
    );

    expect(await listed.json()).toEqual({
      devices: [
        {
          deviceId: registered.deviceId,
          installationId,
          repositoryId: repository.id,
          repository: { owner: repository.owner, name: repository.name },
          registeredAt: expect.any(Number),
          revokedAt: null,
        },
      ],
    });

    const revocation = await app.fetch(
      new Request(
        `https://relay.test/devices/${registered.deviceId}/revocation`,
        { method: "POST", headers: authorized },
      ),
    );

    expect(revocation.status).toBe(200);

    const afterRevocation = await runInDurableObject(
      registryStub(),
      async (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(await sha256Hex(registered.deviceToken)),
    );

    expect(afterRevocation).toBeNull();
  });

  it("refuses a management session that has expired", async () => {
    const app = relay();
    const management = (await (
      await exchange(app, "management")
    ).response.json()) as { managementToken: string };

    currentTime += 300_001;

    const response = await app.fetch(
      new Request("https://relay.test/devices", {
        headers: { authorization: `Bearer ${management.managementToken}` },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a device bearer token as a management credential", async () => {
    const app = relay();
    const registered = (await (await exchange(app)).response.json()) as {
      deviceToken: string;
      deviceId: string;
    };

    const response = await app.fetch(
      new Request(
        `https://relay.test/devices/${registered.deviceId}/revocation`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${registered.deviceToken}` },
        },
      ),
    );

    expect(response.status).toBe(401);
  });
});

describe("cancelling a device that was just issued", () => {
  async function cancel(
    app: ReturnType<typeof relay>,
    body: { deviceId: string; cancellationToken: string },
  ) {
    return app.fetch(
      new Request("https://relay.test/device/cancellation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("cancels only the device the proof was issued for", async () => {
    const app = relay();
    const first = (await (await exchange(app)).response.json()) as {
      deviceId: string;
      deviceToken: string;
      cancellationToken: string;
    };
    const second = (await (
      await exchange(app, "registration", adminCode, "second-state")
    ).response.json()) as { deviceId: string; cancellationToken: string };

    expect(
      (
        await cancel(app, {
          deviceId: second.deviceId,
          cancellationToken: first.cancellationToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cancel(app, {
          deviceId: first.deviceId,
          cancellationToken: "forged",
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await cancel(app, {
          deviceId: first.deviceId,
          cancellationToken: first.cancellationToken,
        })
      ).status,
    ).toBe(200);

    const authenticated = await runInDurableObject(
      registryStub(),
      async (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(await sha256Hex(first.deviceToken)),
    );

    expect(authenticated).toBeNull();
  });

  it("refuses an expired or reused cancellation proof", async () => {
    const app = relay();
    const registered = (await (await exchange(app)).response.json()) as {
      deviceId: string;
      cancellationToken: string;
    };

    currentTime += 120_001;

    expect(
      (
        await cancel(app, {
          deviceId: registered.deviceId,
          cancellationToken: registered.cancellationToken,
        })
      ).status,
    ).toBe(403);
  });
});
