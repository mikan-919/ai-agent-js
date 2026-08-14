import {
  parseDeviceCancellationRequest,
  parseDeviceTokenExchangeRequest,
  type DeviceTokenExchangeResponse,
} from "@mikan-919/oriel-contracts";
import { Hono } from "hono";

import {
  randomSecret,
  sha256Base64Url,
  sha256Hex,
  signPayload,
  verifyPayload,
} from "./crypto";
import type { DeviceRegistryObject } from "./device-registry-object";
import type { RelayGitHubClient } from "./github";

export interface RelayOptions {
  github: RelayGitHubClient;
  deviceRegistry: DurableObjectNamespace<DeviceRegistryObject>;
  signingKey: string;
  relayOrigin: string;
  /** 運用値は測定と検証専用環境から決めるため、relayは既定値を持たない。 */
  codeExpiryMs: number;
  managementSessionExpiryMs: number;
  cancellationExpiryMs: number;
  now?: () => number;
}

interface AuthorizationState {
  codeChallenge: string;
  state: string;
  purpose: "registration" | "management";
  installationId: number;
  repositoryId: number;
  redirectUri: string;
  expiresAt: number;
}

/**
 * 管理session。installationを現在管理できることをGitHub loginの直後に確認してから
 * 短命の署名値として発行し、relayへ保存しない。
 */
interface ManagementSession {
  installationId: number;
  repositoryId: number;
  expiresAt: number;
}

const oauthCallbackPath = "/device/authorize/callback";

/** localhostへ戻す先はloopbackだけに限る。 */
function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** codeと取消証明は、担当するDurable Objectを見つけるための経路情報を前置きする。 */
function routedSecret(installationId: number, repositoryId: number): string {
  return `${installationId}.${repositoryId}.${randomSecret()}`;
}

function routeOf(
  value: string,
): { installationId: number; repositoryId: number } | null {
  const [installationId, repositoryId] = value.split(".");
  const parsed = {
    installationId: Number(installationId),
    repositoryId: Number(repositoryId),
  };

  return Number.isInteger(parsed.installationId) &&
    parsed.installationId > 0 &&
    Number.isInteger(parsed.repositoryId) &&
    parsed.repositoryId > 0
    ? parsed
    : null;
}

export function createRelayApp({
  github,
  deviceRegistry,
  signingKey,
  relayOrigin,
  codeExpiryMs,
  managementSessionExpiryMs,
  cancellationExpiryMs,
  now = Date.now,
}: RelayOptions) {
  const app = new Hono();

  function registryFor(installationId: number, repositoryId: number) {
    return deviceRegistry.get(
      deviceRegistry.idFromName(`${installationId}/${repositoryId}`),
    );
  }

  app.get("/device/authorize", async (context) => {
    const parameters = new URL(context.req.url).searchParams;
    const installationId = Number(parameters.get("installation_id"));
    const repositoryId = Number(parameters.get("repository_id"));
    const codeChallenge = parameters.get("code_challenge") ?? "";
    const state = parameters.get("state") ?? "";
    const redirectUri = parameters.get("redirect_uri") ?? "";
    const purpose =
      parameters.get("purpose") === "management"
        ? "management"
        : "registration";

    if (
      !Number.isInteger(installationId) ||
      installationId <= 0 ||
      !Number.isInteger(repositoryId) ||
      repositoryId <= 0 ||
      codeChallenge === "" ||
      state === "" ||
      parameters.get("code_challenge_method") !== "S256" ||
      !isLoopbackRedirect(redirectUri)
    ) {
      return context.text("Bad Request", 400);
    }

    const authorizationState: AuthorizationState = {
      codeChallenge,
      state,
      purpose,
      installationId,
      repositoryId,
      redirectUri,
      expiresAt: now() + codeExpiryMs,
    };

    return context.redirect(
      github.authorizeUrl({
        state: await signPayload(signingKey, authorizationState),
        redirectUri: `${relayOrigin}${oauthCallbackPath}`,
      }),
      302,
    );
  });

  app.get(oauthCallbackPath, async (context) => {
    const parameters = new URL(context.req.url).searchParams;
    const started = await verifyPayload<AuthorizationState>(
      signingKey,
      parameters.get("state") ?? "",
    );

    if (started === null || started.expiresAt < now()) {
      return context.text("Bad Request", 400);
    }

    const userToken = await github.exchangeAuthorizationCode({
      code: parameters.get("code") ?? "",
      redirectUri: `${relayOrigin}${oauthCallbackPath}`,
    });
    const viewer =
      userToken === null ? null : await github.getViewer(userToken);

    if (userToken === null || viewer === null) {
      return context.text("Unauthorized", 401);
    }

    const repositories = await github.listInstallationRepositories({
      userToken,
      installationId: started.installationId,
    });
    const repository = repositories.find(
      (candidate) => candidate.id === started.repositoryId,
    );

    if (repository === undefined) {
      return context.text("Forbidden", 403);
    }

    if (
      started.purpose === "management" &&
      !(await github.canAdministerInstallation({
        userToken,
        installationId: started.installationId,
      }))
    ) {
      return context.text("Forbidden", 403);
    }

    const code = routedSecret(started.installationId, started.repositoryId);
    const registry = registryFor(started.installationId, started.repositoryId);

    await registry.purgeExpired(now());
    await registry.issueCode({
      codeHash: await sha256Hex(code),
      codeChallenge: started.codeChallenge,
      state: started.state,
      purpose: started.purpose,
      installationId: started.installationId,
      repositoryId: started.repositoryId,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      expiresAt: now() + codeExpiryMs,
    });

    const target = new URL(started.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", started.state);

    return context.redirect(target.toString(), 302);
  });

  app.post("/device/token", async (context) => {
    let request;

    try {
      request = parseDeviceTokenExchangeRequest(await context.req.json());
    } catch {
      return context.text("Bad Request", 400);
    }

    const route = routeOf(request.code);

    if (route === null) {
      return context.text("Bad Request", 400);
    }

    const registry = registryFor(route.installationId, route.repositoryId);
    const consumed = await registry.consumeCode(await sha256Hex(request.code));

    if (
      consumed === null ||
      consumed.expiresAt < now() ||
      (await sha256Base64Url(request.codeVerifier)) !== consumed.codeChallenge
    ) {
      return context.text("Bad Request", 400);
    }

    const repository = {
      owner: consumed.repositoryOwner,
      name: consumed.repositoryName,
    };

    if (consumed.purpose === "management") {
      const session: ManagementSession = {
        installationId: consumed.installationId,
        repositoryId: consumed.repositoryId,
        expiresAt: now() + managementSessionExpiryMs,
      };
      const response: DeviceTokenExchangeResponse = {
        purpose: "management",
        managementToken: await signPayload(signingKey, session),
        expiresAt: session.expiresAt,
        installationId: consumed.installationId,
        repositoryId: consumed.repositoryId,
        repository,
      };

      return context.json(response);
    }

    const deviceToken = randomSecret();
    const cancellationToken = routedSecret(
      consumed.installationId,
      consumed.repositoryId,
    );
    const cancellationExpiresAt = now() + cancellationExpiryMs;
    const registered = await registry.registerDevice({
      deviceId: crypto.randomUUID(),
      deviceTokenHash: await sha256Hex(deviceToken),
      cancellationTokenHash: await sha256Hex(cancellationToken),
      cancellationExpiresAt,
      installationId: consumed.installationId,
      repositoryId: consumed.repositoryId,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      registeredAt: now(),
    });
    const response: DeviceTokenExchangeResponse = {
      purpose: "registration",
      deviceId: registered.deviceId,
      deviceToken,
      cancellationToken,
      cancellationExpiresAt,
      installationId: consumed.installationId,
      repositoryId: consumed.repositoryId,
      repository,
    };

    return context.json(response);
  });

  async function managementSession(
    header: string | undefined,
  ): Promise<ManagementSession | null> {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const session = await verifyPayload<ManagementSession>(signingKey, token);

    return session === null || session.expiresAt < now() ? null : session;
  }

  app.get("/devices", async (context) => {
    const session = await managementSession(
      context.req.header("authorization"),
    );

    if (session === null) {
      return context.text("Unauthorized", 401);
    }

    const devices = await registryFor(
      session.installationId,
      session.repositoryId,
    ).listDevices();

    return context.json({ devices });
  });

  app.post("/devices/:deviceId/revocation", async (context) => {
    const session = await managementSession(
      context.req.header("authorization"),
    );

    if (session === null) {
      return context.text("Unauthorized", 401);
    }

    const revoked = await registryFor(
      session.installationId,
      session.repositoryId,
    ).revokeDevice(context.req.param("deviceId"), now());

    if (revoked === null || revoked.revokedAt === null) {
      return context.text("Not Found", 404);
    }

    return context.json({
      deviceId: revoked.deviceId,
      revokedAt: revoked.revokedAt,
    });
  });

  app.post("/device/cancellation", async (context) => {
    let request;

    try {
      request = parseDeviceCancellationRequest(await context.req.json());
    } catch {
      return context.text("Bad Request", 400);
    }

    const route = routeOf(request.cancellationToken);

    if (route === null) {
      return context.text("Forbidden", 403);
    }

    const outcome = await registryFor(
      route.installationId,
      route.repositoryId,
    ).cancelIssuedDevice({
      deviceId: request.deviceId,
      cancellationTokenHash: await sha256Hex(request.cancellationToken),
      now: now(),
    });

    return outcome === "cancelled"
      ? context.json({ deviceId: request.deviceId, cancelled: true })
      : context.text("Forbidden", 403);
  });

  return app;
}
