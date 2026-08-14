import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "bun:test";

import {
  createDeviceRegistrationFlow,
  type DeviceTokenStore,
} from "./device-registration";
import { createRelayDeviceClient, type RelayFetch } from "./relay-client";

const installationId = 7;
const repository = { id: 11, owner: "mikan-919", name: "oriel" };
const authorizeEndpoint = new URL("https://relay.test/device/authorize");
const redirectUri = new URL("http://127.0.0.1:49152/device/callback");
const managementToken = "management-session-token";

interface FakeRelayOptions {
  /** repository idを取り違えて返すrelayを再現する。 */
  repositoryIdOverride?: number;
  cancellationOutcome?: () => "cancelled" | "refused" | "unknown";
  now?: () => number;
}

/**
 * relayのHTTP contractに合わせたfake。実物はworkerd上のvitestで検証する。
 */
function fakeRelay({
  repositoryIdOverride,
  cancellationOutcome = () => "cancelled" as const,
  now = () => 1_000,
}: FakeRelayOptions = {}) {
  const codes = new Map<
    string,
    { codeChallenge: string; purpose: "registration" | "management" }
  >();
  const devices = new Map<
    string,
    { cancellationToken: string; revokedAt: number | null }
  >();

  const relayFetch: RelayFetch = async (input, init) => {
    const url = new URL(input);
    const body =
      init?.body === undefined ? {} : JSON.parse(String(init.body ?? "{}"));
    const bearer = new Headers(init?.headers).get("authorization");
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/device/token") {
      const issued = codes.get(body.code);
      codes.delete(body.code);

      if (
        issued === undefined ||
        createHash("sha256").update(body.codeVerifier).digest("base64url") !==
          issued.codeChallenge
      ) {
        return new Response("Bad Request", { status: 400 });
      }

      if (issued.purpose === "management") {
        return json({
          purpose: "management",
          managementToken,
          expiresAt: now() + 300_000,
          installationId,
          repositoryId: repositoryIdOverride ?? repository.id,
          repository: { owner: repository.owner, name: repository.name },
        });
      }

      const deviceId = randomUUID();
      const cancellationToken = `cancellation-${deviceId}`;
      devices.set(deviceId, { cancellationToken, revokedAt: null });

      return json({
        purpose: "registration",
        deviceId,
        deviceToken: `device-token-${deviceId}`,
        cancellationToken,
        cancellationExpiresAt: now() + 120_000,
        installationId,
        repositoryId: repositoryIdOverride ?? repository.id,
        repository: { owner: repository.owner, name: repository.name },
      });
    }

    if (url.pathname === "/device/cancellation") {
      if (cancellationOutcome() === "unknown") {
        return new Response("Service Unavailable", { status: 503 });
      }

      const device = devices.get(body.deviceId);

      if (
        cancellationOutcome() === "refused" ||
        device === undefined ||
        device.cancellationToken !== body.cancellationToken
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      device.revokedAt = now();
      return json({ deviceId: body.deviceId, cancelled: true });
    }

    if (bearer !== `Bearer ${managementToken}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/devices") {
      return json({
        devices: [...devices].map(([deviceId, device]) => ({
          deviceId,
          installationId,
          repositoryId: repository.id,
          repository: { owner: repository.owner, name: repository.name },
          registeredAt: now(),
          revokedAt: device.revokedAt,
        })),
      });
    }

    const revoking = url.pathname.match(/^\/devices\/([^/]+)\/revocation$/);
    const device =
      revoking === null
        ? undefined
        : devices.get(decodeURIComponent(revoking[1]!));

    if (device === undefined) {
      return new Response("Not Found", { status: 404 });
    }

    device.revokedAt ??= now();
    return json({ deviceId: revoking![1], revokedAt: device.revokedAt });
  };

  return {
    devices,
    client: createRelayDeviceClient({
      baseUrl: "https://relay.test",
      fetch: relayFetch,
    }),
    /** browserがrelayの認可を通り、localhostへ戻るまでを再現する。 */
    authorizeInBrowser(authorizeUrl: URL): URL {
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        codeChallenge: authorizeUrl.searchParams.get("code_challenge") ?? "",
        purpose:
          authorizeUrl.searchParams.get("purpose") === "management"
            ? "management"
            : "registration",
      });

      const callbackUrl = new URL(
        authorizeUrl.searchParams.get("redirect_uri") ?? "",
      );
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state") ?? "",
      );

      return callbackUrl;
    },
  };
}

function setup(
  options: FakeRelayOptions & { tokenStore?: DeviceTokenStore } = {},
) {
  const stored: { repositoryId: number; deviceToken: string }[] = [];
  const relay = fakeRelay(options);
  const flow = createDeviceRegistrationFlow({
    relay: relay.client,
    tokenStore:
      options.tokenStore ??
      ({
        set: async (input) => {
          stored.push(input);
        },
      } satisfies DeviceTokenStore),
    authorizeEndpoint,
    redirectUri,
    now: options.now ?? (() => 1_000),
  });

  return { flow, relay, stored };
}

async function register(
  context: ReturnType<typeof setup>,
  purpose: "registration" | "management" = "registration",
) {
  const { authorizeUrl } = context.flow.begin({
    installationId,
    repositoryId: repository.id,
    purpose,
  });

  return context.flow.complete(context.relay.authorizeInBrowser(authorizeUrl));
}

test("registration starts from localhost and stores the token in the credential store", async () => {
  const context = setup();
  const { authorizeUrl } = context.flow.begin({
    installationId,
    repositoryId: repository.id,
  });

  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("purpose")).toBe("registration");
  expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
    redirectUri.toString(),
  );

  const callbackUrl = context.relay.authorizeInBrowser(authorizeUrl);

  expect([...callbackUrl.searchParams.keys()].sort()).toEqual([
    "code",
    "state",
  ]);

  const result = await context.flow.complete(callbackUrl);

  expect(result).toEqual({
    status: "registered",
    deviceId: expect.any(String),
  });
  expect(context.stored).toHaveLength(1);
  expect(context.stored[0]?.repositoryId).toBe(repository.id);
  expect(JSON.stringify(result)).not.toContain(
    context.stored[0]?.deviceToken ?? "unreachable",
  );
  expect(callbackUrl.toString()).not.toContain(
    context.stored[0]?.deviceToken ?? "unreachable",
  );
});

test("a callback with a foreign, reused, or overloaded state is refused", async () => {
  const context = setup();
  const { authorizeUrl } = context.flow.begin({
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = context.relay.authorizeInBrowser(authorizeUrl);
  const forged = new URL(callbackUrl);
  forged.searchParams.set("state", "other-state");

  expect(await context.flow.complete(forged)).toEqual({
    status: "rejected",
    reason: "unknown_state",
  });

  const smuggled = new URL(callbackUrl);
  smuggled.searchParams.set("device_token", "smuggled");

  expect(await context.flow.complete(smuggled)).toEqual({
    status: "rejected",
    reason: "invalid_callback",
  });
  expect(await context.flow.complete(callbackUrl)).toMatchObject({
    status: "registered",
  });
  expect(await context.flow.complete(callbackUrl)).toEqual({
    status: "rejected",
    reason: "unknown_state",
  });
  expect(context.stored).toHaveLength(1);
});

test("a credential store failure cancels the issued device and fails closed", async () => {
  const context = setup({
    tokenStore: {
      set: async () => {
        throw new Error("Secret Service is unavailable");
      },
    },
  });

  expect(await register(context)).toEqual({
    status: "rejected",
    reason: "credential_store_unavailable",
  });
  expect(context.stored).toHaveLength(0);
  expect([...context.relay.devices.values()]).toEqual([
    { cancellationToken: expect.any(String), revokedAt: expect.any(Number) },
  ]);
  expect(context.flow.pendingCancellations()).toEqual([]);
});

test("an unconfirmed cancellation is held for reconciliation instead of being reported as done", async () => {
  const context = setup({
    cancellationOutcome: () => "unknown",
    tokenStore: {
      set: async () => {
        throw new Error("Secret Service is unavailable");
      },
    },
  });
  const result = await register(context);

  expect(result).toEqual({
    status: "reconciliation_required",
    deviceId: expect.any(String),
  });
  expect(context.stored).toHaveLength(0);
  expect(context.flow.pendingCancellations()).toEqual([
    {
      deviceId: expect.any(String),
      cancellationToken: expect.any(String),
      cancellationExpiresAt: expect.any(Number),
    },
  ]);
});

test("a held cancellation converges once the relay answers again", async () => {
  let outcome: "cancelled" | "unknown" = "unknown";
  const context = setup({
    cancellationOutcome: () => outcome,
    tokenStore: {
      set: async () => {
        throw new Error("Secret Service is unavailable");
      },
    },
  });

  await register(context);

  expect(context.flow.pendingCancellations()).toHaveLength(1);

  outcome = "cancelled";

  expect(await context.flow.retryPendingCancellations()).toEqual([]);
  expect([...context.relay.devices.values()]).toEqual([
    { cancellationToken: expect.any(String), revokedAt: expect.any(Number) },
  ]);
});

test("a relay that answers for another repository does not register a device", async () => {
  const context = setup({ repositoryIdOverride: repository.id + 1 });

  expect(await register(context)).toEqual({
    status: "rejected",
    reason: "registration_target_mismatch",
  });
  expect(context.stored).toHaveLength(0);
  expect([...context.relay.devices.values()]).toEqual([
    { cancellationToken: expect.any(String), revokedAt: expect.any(Number) },
  ]);
});

test("listing and revoking devices needs a current management session", async () => {
  const context = setup();
  const registered = await register(context);

  expect(await context.flow.listDevices()).toBeNull();
  expect(
    await context.flow.revokeDevice(
      registered.status === "registered" ? registered.deviceId : "",
    ),
  ).toBe(false);

  expect(await register(context, "management")).toEqual({
    status: "management_session",
    expiresAt: expect.any(Number),
  });
  expect(await context.flow.listDevices()).toEqual([
    {
      deviceId: expect.any(String),
      installationId,
      repositoryId: repository.id,
      repository: { owner: repository.owner, name: repository.name },
      registeredAt: expect.any(Number),
      revokedAt: null,
    },
  ]);

  expect(
    await context.flow.revokeDevice(
      registered.status === "registered" ? registered.deviceId : "",
    ),
  ).toBe(true);
  expect([...context.relay.devices.values()][0]?.revokedAt).toEqual(
    expect.any(Number),
  );
});

test("an expired management session stops managing devices", async () => {
  let currentTime = 1_000;
  const context = setup({ now: () => currentTime });

  await register(context, "management");

  expect(context.flow.hasManagementSession()).toBe(true);

  currentTime += 300_001;

  expect(context.flow.hasManagementSession()).toBe(false);
  expect(await context.flow.listDevices()).toBeNull();
  expect(await context.flow.revokeDevice("any")).toBe(false);
});
