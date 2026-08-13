import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import {
  createDeviceRegistrationFlow,
  type DeviceTokenStore,
} from "./device-registration";
import {
  createDeviceRegistry,
  type GitHubInstallationDirectory,
} from "./device-registry";
import { createConnectionOwnershipArbiter } from "./job-ownership";

const installationId = 7;
const repository = { id: 11, owner: "mikan-919", name: "oriel" };
const userToken = "github-user-token";
const authorizeEndpoint = new URL("https://relay.example/device/authorize");
const redirectUri = new URL("http://127.0.0.1:49152/device/callback");

const github: GitHubInstallationDirectory = {
  getViewer: async (token) =>
    token === userToken ? { id: 1, login: "mikan-919" } : null,
  canAdministerInstallation: async ({ userToken: token }) =>
    token === userToken,
  listInstallationRepositories: async () => [repository],
};

function setup(tokenStore?: DeviceTokenStore) {
  const stored: { repositoryId: number; deviceToken: string }[] = [];
  const registry = createDeviceRegistry({
    github,
    ownership: createConnectionOwnershipArbiter({ heartbeatExpiryMs: 60_000 }),
    codeExpiryMs: 60_000,
  });
  const flow = createDeviceRegistrationFlow({
    relay: registry,
    tokenStore: tokenStore ?? {
      set: async (input) => {
        stored.push(input);
      },
    },
    authorizeEndpoint,
    redirectUri,
  });

  return { flow, registry, stored };
}

/** browserがrelayの認可画面を通り、localhostへ戻るまでを再現する。 */
async function browserAuthorize(
  registry: ReturnType<typeof setup>["registry"],
  authorizeUrl: URL,
): Promise<URL> {
  const parameters = authorizeUrl.searchParams;
  const authorization = await registry.authorize({
    userToken,
    installationId: Number(parameters.get("installation_id")),
    repositoryId: Number(parameters.get("repository_id")),
    codeChallenge: parameters.get("code_challenge") ?? "",
    codeChallengeMethod: parameters.get("code_challenge_method") ?? "",
    state: parameters.get("state") ?? "",
  });

  if (authorization.status !== "issued") {
    throw new Error(`authorize failed: ${authorization.reason}`);
  }

  const callbackUrl = new URL(parameters.get("redirect_uri") ?? "");
  callbackUrl.searchParams.set("code", authorization.code);
  callbackUrl.searchParams.set("state", authorization.state);

  return callbackUrl;
}

test("registration starts from localhost and returns a device the relay can authenticate", async () => {
  const { flow, registry, stored } = setup();
  const { authorizeUrl } = flow.begin({
    installationId,
    repositoryId: repository.id,
  });

  expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
    authorizeEndpoint.toString(),
  );
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
    redirectUri.toString(),
  );
  expect(authorizeUrl.searchParams.get("state")).toBeTruthy();

  const callbackUrl = await browserAuthorize(registry, authorizeUrl);

  expect([...callbackUrl.searchParams.keys()].sort()).toEqual([
    "code",
    "state",
  ]);

  const result = await flow.complete(callbackUrl);

  expect(result).toEqual({
    status: "registered",
    deviceId: expect.any(String),
  });
  expect(stored).toHaveLength(1);
  expect(stored[0]?.repositoryId).toBe(repository.id);
  expect(
    registry.authenticateDevice(stored[0]?.deviceToken ?? ""),
  ).toMatchObject({ installationId, repositoryId: repository.id });
});

test("the device token never leaves the credential store path", async () => {
  const { flow, registry, stored } = setup();
  const { authorizeUrl } = flow.begin({
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = await browserAuthorize(registry, authorizeUrl);
  const result = await flow.complete(callbackUrl);
  const deviceToken = stored[0]?.deviceToken ?? "";

  expect(deviceToken).not.toBe("");
  expect(JSON.stringify(result)).not.toContain(deviceToken);
  expect(authorizeUrl.toString()).not.toContain(deviceToken);
  expect(callbackUrl.toString()).not.toContain(deviceToken);

  // 一回限りcodeはPKCE verifierを持つserveだけが交換できる。verifierはURLへ出ない。
  const codeChallenge = authorizeUrl.searchParams.get("code_challenge") ?? "";

  expect(codeChallenge).not.toBe("");

  for (const value of [
    ...authorizeUrl.searchParams.values(),
    ...callbackUrl.searchParams.values(),
  ]) {
    expect(createHash("sha256").update(value).digest("base64url")).not.toBe(
      codeChallenge,
    );
  }
});

test("a callback with a foreign or reused state is refused", async () => {
  const { flow, registry, stored } = setup();
  const { authorizeUrl } = flow.begin({
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = await browserAuthorize(registry, authorizeUrl);
  const forgedUrl = new URL(callbackUrl);
  forgedUrl.searchParams.set("state", "other-state");

  expect(await flow.complete(forgedUrl)).toEqual({
    status: "rejected",
    reason: "unknown_state",
  });
  expect(await flow.complete(callbackUrl)).toMatchObject({
    status: "registered",
  });
  expect(await flow.complete(callbackUrl)).toEqual({
    status: "rejected",
    reason: "unknown_state",
  });
  expect(stored).toHaveLength(1);
});

test("a callback carrying anything besides code and state is refused", async () => {
  const { flow, registry } = setup();
  const { authorizeUrl } = flow.begin({
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = await browserAuthorize(registry, authorizeUrl);

  callbackUrl.searchParams.set("device_token", "smuggled");

  expect(await flow.complete(callbackUrl)).toEqual({
    status: "rejected",
    reason: "invalid_callback",
  });
});

test("a credential store failure revokes the issued device and fails closed", async () => {
  const { flow, registry, stored } = setup({
    set: async () => {
      throw new Error("Secret Service is unavailable");
    },
  });
  const { authorizeUrl } = flow.begin({
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = await browserAuthorize(registry, authorizeUrl);
  const result = await flow.complete(callbackUrl);

  expect(result).toEqual({
    status: "rejected",
    reason: "credential_store_unavailable",
  });
  expect(stored).toHaveLength(0);

  const devices = await registry.listDevices({ userToken, installationId });

  expect(devices).toHaveLength(1);
  expect(devices[0]?.revokedAt).toEqual(expect.any(Number));
});

test("a relay that hands back another repository is refused", async () => {
  const { flow, registry } = setup();
  const { authorizeUrl } = flow.begin({
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = await browserAuthorize(registry, authorizeUrl);
  const flowAgainstOtherRepository = createDeviceRegistrationFlow({
    relay: {
      exchange: async (request) => {
        const exchanged = await registry.exchange(request);

        return exchanged.status === "issued"
          ? { ...exchanged, repositoryId: repository.id + 1 }
          : exchanged;
      },
      revoke: registry.revoke,
    },
    tokenStore: { set: async () => {} },
    authorizeEndpoint,
    redirectUri,
  });
  const { authorizeUrl: otherUrl } = flowAgainstOtherRepository.begin({
    installationId,
    repositoryId: repository.id,
  });
  const otherCallbackUrl = await browserAuthorize(registry, otherUrl);

  expect(await flowAgainstOtherRepository.complete(otherCallbackUrl)).toEqual({
    status: "rejected",
    reason: "registration_target_mismatch",
  });
  expect(
    (await registry.listDevices({ userToken, installationId })).every(
      (device) => device.revokedAt !== null,
    ),
  ).toBe(true);
  expect(await flow.complete(callbackUrl)).toMatchObject({
    status: "registered",
  });
});
