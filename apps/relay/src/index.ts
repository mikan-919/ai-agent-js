import { identity, userAgent } from "@mikan-919/oriel-identity";

import { DeviceRegistryObject } from "./device-registry-object";
import { createGitHubClient } from "./github";
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
}

function requiredMilliseconds(value: string, name: string): number {
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
      }),
      deviceRegistry: env.DEVICE_REGISTRY,
      signingKey: env.RELAY_SIGNING_KEY,
      relayOrigin: env.RELAY_ORIGIN,
      codeExpiryMs: requiredMilliseconds(
        env.DEVICE_CODE_EXPIRY_MS,
        "DEVICE_CODE_EXPIRY_MS",
      ),
      cancellationExpiryMs: requiredMilliseconds(
        env.DEVICE_CANCELLATION_EXPIRY_MS,
        "DEVICE_CANCELLATION_EXPIRY_MS",
      ),
    });

    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<RelayEnv>;
