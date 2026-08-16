import { identity, userAgent } from "@mikan-919/oriel-identity";

import { DeviceRegistryObject } from "./device-registry-object";
import { createGitHubClient } from "./github";
import {
  minimalInstallationTokenPermissions,
  parseInstallationTokenPermissions,
} from "./installation-token-permissions";
import { createRelayApp } from "./relay";

export { DeviceRegistryObject };

export interface RelayEnv {
  DEVICE_REGISTRY: DurableObjectNamespace<DeviceRegistryObject>;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  RELAY_SIGNING_KEY: string;
  RELAY_ORIGIN: string;
  RELAY_VERSION: string;
  /** 運用値はdeploy設定から与える。欠けている場合はfail closedにする。 */
  DEVICE_CODE_EXPIRY_MS: string;
  DEVICE_CANCELLATION_EXPIRY_MS: string;
  OWNERSHIP_HEARTBEAT_INTERVAL_MS: string;
  OWNERSHIP_HEARTBEAT_EXPIRY_MS: string;
  OWNERSHIP_AUDIT_INTERVAL_MS: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_JWT_LIFETIME_SECONDS: string;
  /**
   * installation tokenへ載せる権限のJSON。省略時は固定allowlistの最小権限を使い、
   * 与えた場合もallowlistを越える権限は受け付けない。
   */
  INSTALLATION_TOKEN_PERMISSIONS?: string;
}

function requiredPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${identity.environmentPrefix}${name} is not configured`);
  }

  return parsed;
}

export default {
  fetch(request: Request, env: RelayEnv, context: ExecutionContext) {
    const app = createRelayApp({
      github: createGitHubClient({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        userAgent: userAgent(env.RELAY_VERSION),
        appId: env.GITHUB_APP_ID,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
        appJwtLifetimeSeconds: requiredPositiveInteger(
          env.GITHUB_APP_JWT_LIFETIME_SECONDS,
          "GITHUB_APP_JWT_LIFETIME_SECONDS",
        ),
      }),
      deviceRegistry: env.DEVICE_REGISTRY,
      signingKey: env.RELAY_SIGNING_KEY,
      relayOrigin: env.RELAY_ORIGIN,
      codeExpiryMs: requiredPositiveInteger(
        env.DEVICE_CODE_EXPIRY_MS,
        "DEVICE_CODE_EXPIRY_MS",
      ),
      cancellationExpiryMs: requiredPositiveInteger(
        env.DEVICE_CANCELLATION_EXPIRY_MS,
        "DEVICE_CANCELLATION_EXPIRY_MS",
      ),
      ownershipHeartbeatIntervalMs: requiredPositiveInteger(
        env.OWNERSHIP_HEARTBEAT_INTERVAL_MS,
        "OWNERSHIP_HEARTBEAT_INTERVAL_MS",
      ),
      ownershipHeartbeatExpiryMs: requiredPositiveInteger(
        env.OWNERSHIP_HEARTBEAT_EXPIRY_MS,
        "OWNERSHIP_HEARTBEAT_EXPIRY_MS",
      ),
      ownershipAuditIntervalMs: requiredPositiveInteger(
        env.OWNERSHIP_AUDIT_INTERVAL_MS,
        "OWNERSHIP_AUDIT_INTERVAL_MS",
      ),
      installationTokenPermissions:
        env.INSTALLATION_TOKEN_PERMISSIONS === undefined
          ? minimalInstallationTokenPermissions
          : parseInstallationTokenPermissions(
              env.INSTALLATION_TOKEN_PERMISSIONS,
            ),
    });

    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<RelayEnv>;
