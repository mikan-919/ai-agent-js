import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { openServeLocalState } from "./local-state";
import { createPendingCancellationStore } from "./pending-cancellations";
import { createRelayDeviceClient } from "./relay-client";
import { startServeHttpServer } from "./server";

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}

if (Bun.argv[2] === "serve") {
  const environment = Bun.env[`${identity.environmentPrefix}RELAY_ORIGIN`];
  const statePath = Bun.env[`${identity.environmentPrefix}STATE_PATH`];
  const httpServer = startServeHttpServer({
    createDeviceRegistration:
      environment === undefined || statePath === undefined
        ? undefined
        : (redirectUri) => {
            const flow = createDeviceRegistrationFlow({
              relay: createRelayDeviceClient({ baseUrl: environment }),
              tokenStore: bunSecretsDeviceTokenStore(),
              authorizeEndpoint: new URL("/device/authorize", environment),
              redirectUri,
              cancellationStore: createPendingCancellationStore(
                openServeLocalState(statePath),
              ),
            });

            // 前回の起動で取り消せなかった発行済deviceを収束させる。
            void flow.resumePendingCancellations();

            return flow;
          },
  });

  console.log(httpServer.readinessUrl.toString());
}
