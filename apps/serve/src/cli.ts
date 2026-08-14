import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { createRelayDeviceClient } from "./relay-client";
import { startServeHttpServer } from "./server";

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}

if (Bun.argv[2] === "serve") {
  const relayOrigin = Bun.env[`${identity.environmentPrefix}RELAY_ORIGIN`];
  const httpServer = startServeHttpServer({
    createDeviceRegistration:
      relayOrigin === undefined
        ? undefined
        : (redirectUri) =>
            createDeviceRegistrationFlow({
              relay: createRelayDeviceClient({ baseUrl: relayOrigin }),
              tokenStore: bunSecretsDeviceTokenStore(),
              authorizeEndpoint: new URL("/device/authorize", relayOrigin),
              redirectUri,
            }),
  });

  console.log(httpServer.readinessUrl.toString());
}
