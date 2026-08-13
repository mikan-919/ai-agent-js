import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import {
  createDeviceRegistry,
  type GitHubInstallationDirectory,
} from "./device-registry";
import { createConnectionOwnershipArbiter } from "./job-ownership";

const installationId = 7;
const repository = { id: 11, owner: "mikan-919", name: "oriel" };
const adminToken = "github-user-token-admin";
const memberToken = "github-user-token-member";
const codeVerifier = "verifier-value";
const codeChallenge = createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");

function fakeGitHub(
  overrides: Partial<GitHubInstallationDirectory> = {},
): GitHubInstallationDirectory {
  return {
    getViewer: async (userToken) =>
      userToken === adminToken || userToken === memberToken
        ? { id: userToken === adminToken ? 1 : 2, login: userToken }
        : null,
    canAdministerInstallation: async ({ userToken }) =>
      userToken === adminToken,
    listInstallationRepositories: async () => [repository],
    ...overrides,
  };
}

function setup(
  github: GitHubInstallationDirectory = fakeGitHub(),
  now: () => number = Date.now,
) {
  const ownership = createConnectionOwnershipArbiter({
    heartbeatExpiryMs: 60_000,
    now,
  });
  const registry = createDeviceRegistry({
    github,
    ownership,
    codeExpiryMs: 60_000,
    now,
  });

  return { ownership, registry };
}

function authorize(
  registry: ReturnType<typeof setup>["registry"],
  userToken = memberToken,
  state = "state-1",
) {
  return registry.authorize({
    userToken,
    installationId,
    repositoryId: repository.id,
    codeChallenge,
    codeChallengeMethod: "S256",
    state,
  });
}

async function register(registry: ReturnType<typeof setup>["registry"]) {
  const authorization = await authorize(registry);

  if (authorization.status !== "issued") {
    throw new Error(`authorize failed: ${authorization.reason}`);
  }

  const exchange = await registry.exchange({
    code: authorization.code,
    codeVerifier,
  });

  if (exchange.status !== "issued") {
    throw new Error(`exchange failed: ${exchange.reason}`);
  }

  return exchange;
}

test("a signed-in user registers a repository of the current installation", async () => {
  const { registry } = setup();

  const authorization = await authorize(registry);

  expect(authorization).toMatchObject({ status: "issued", state: "state-1" });

  const registration = await register(registry);

  expect(registration.installationId).toBe(installationId);
  expect(registration.repositoryId).toBe(repository.id);
  expect(registry.authenticateDevice(registration.deviceToken)).toEqual({
    deviceId: registration.deviceId,
    installationId,
    repositoryId: repository.id,
  });
});

test("registration is refused without a GitHub login or a current repository selection", async () => {
  const { registry } = setup();

  expect(await authorize(registry, "expired-user-token")).toEqual({
    status: "rejected",
    reason: "github_login_required",
  });

  const detached = setup(
    fakeGitHub({ listInstallationRepositories: async () => [] }),
  );

  expect(await authorize(detached.registry)).toEqual({
    status: "rejected",
    reason: "repository_not_in_installation",
  });
});

test("the one-time code is exchanged only with the matching verifier", async () => {
  const { registry } = setup();
  const authorization = await authorize(registry);

  if (authorization.status !== "issued") throw new Error("authorize failed");

  expect(
    await registry.exchange({
      code: authorization.code,
      codeVerifier: "other-verifier",
    }),
  ).toEqual({ status: "rejected", reason: "code_verifier_mismatch" });

  // 失敗した交換もcodeを消費する。正しいverifierでも再利用できない。
  expect(
    await registry.exchange({ code: authorization.code, codeVerifier }),
  ).toEqual({ status: "rejected", reason: "unknown_code" });

  expect(await register(registry)).toMatchObject({ status: "issued" });
});

test("the one-time code is exchanged atomically at most once", async () => {
  const { registry } = setup();
  const authorization = await authorize(registry);

  if (authorization.status !== "issued") throw new Error("authorize failed");

  const results = await Promise.all([
    registry.exchange({ code: authorization.code, codeVerifier }),
    registry.exchange({ code: authorization.code, codeVerifier }),
  ]);

  expect(results.filter((result) => result.status === "issued")).toHaveLength(
    1,
  );
  expect(results.filter((result) => result.status === "rejected")).toEqual([
    { status: "rejected", reason: "unknown_code" },
  ]);
});

test("an expired code cannot be exchanged", async () => {
  let currentTime = 1_000;
  const { registry } = setup(fakeGitHub(), () => currentTime);
  const authorization = await authorize(registry);

  if (authorization.status !== "issued") throw new Error("authorize failed");

  currentTime += 60_001;

  expect(
    await registry.exchange({ code: authorization.code, codeVerifier }),
  ).toEqual({ status: "rejected", reason: "code_expired" });
});

test("the registry persists only a token hash and the metadata it routes by", async () => {
  const { registry } = setup();
  const registration = await register(registry);
  const persisted = await registry.listDevices({
    userToken: adminToken,
    installationId,
  });

  expect(persisted).toEqual([
    {
      deviceId: registration.deviceId,
      deviceTokenHash: createHash("sha256")
        .update(registration.deviceToken)
        .digest("hex"),
      installationId,
      repositoryId: repository.id,
      repository: { owner: repository.owner, name: repository.name },
      registeredAt: expect.any(Number),
      revokedAt: null,
    },
  ]);

  const serialized = JSON.stringify(persisted);

  expect(serialized).not.toContain(registration.deviceToken);
  expect(serialized).not.toContain(memberToken);
  expect(serialized).not.toContain(codeVerifier);
});

test("only a user who currently administers the installation revokes a device", async () => {
  const { registry } = setup();
  const registration = await register(registry);

  expect(
    await registry.revoke({
      actor: { type: "github_user", userToken: memberToken },
      deviceId: registration.deviceId,
    }),
  ).toEqual({ status: "rejected", reason: "not_installation_admin" });
  expect(registry.authenticateDevice(registration.deviceToken)).not.toBeNull();

  expect(
    await registry.revoke({
      actor: { type: "github_user", userToken: adminToken },
      deviceId: registration.deviceId,
    }),
  ).toEqual({ status: "revoked" });
  expect(registry.authenticateDevice(registration.deviceToken)).toBeNull();
});

test("a device revokes itself but not another device", async () => {
  const { registry } = setup();
  const first = await register(registry);
  const second = await register(registry);

  expect(
    await registry.revoke({
      actor: { type: "device", deviceToken: second.deviceToken },
      deviceId: first.deviceId,
    }),
  ).toEqual({ status: "rejected", reason: "not_device_owner" });

  expect(
    await registry.revoke({
      actor: { type: "device", deviceToken: first.deviceToken },
      deviceId: first.deviceId,
    }),
  ).toEqual({ status: "revoked" });
  expect(registry.authenticateDevice(first.deviceToken)).toBeNull();
  expect(registry.authenticateDevice(second.deviceToken)).not.toBeNull();
});

test("revocation invalidates ownership before closing it and refuses new connections", async () => {
  const { ownership, registry } = setup();
  const registration = await register(registry);
  const observed: { confirmedWhileClosing: boolean | null } = {
    confirmedWhileClosing: null,
  };
  const acquisition = await ownership.acquireJobOwnership({
    jobId: "job-1",
    deviceId: registration.deviceId,
    onClosed: () => {
      observed.confirmedWhileClosing = ownership.confirmJobOwnership({
        jobId: "job-1",
        jobLeaseId:
          acquisition.status === "acquired" ? acquisition.jobLeaseId : "",
      }) as boolean;
    },
  });

  if (acquisition.status !== "acquired") throw new Error("acquire failed");

  await registry.revoke({
    actor: { type: "github_user", userToken: adminToken },
    deviceId: registration.deviceId,
  });

  expect(observed.confirmedWhileClosing).toBe(false);
  expect(
    await ownership.acquireJobOwnership({
      jobId: "job-2",
      deviceId: registration.deviceId,
    }),
  ).toEqual({ status: "rejected", reason: "device_revoked" });
});

test("revoking an unknown device is refused", async () => {
  const { registry } = setup();

  expect(
    await registry.revoke({
      actor: { type: "github_user", userToken: adminToken },
      deviceId: "missing",
    }),
  ).toEqual({ status: "rejected", reason: "unknown_device" });
});
