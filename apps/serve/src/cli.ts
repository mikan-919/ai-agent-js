import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { startIssueConversationJob } from "./issue-conversation-job";
import { openServeLocalState } from "./local-state";
import { createPendingCancellationStore } from "./pending-cancellations";
import { createRelayDeviceClient } from "./relay-client";
import { startServeHttpServer } from "./server";

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}

function requiredNumber(name: string): number | undefined {
  const value = Number(Bun.env[`${identity.environmentPrefix}${name}`]);

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

if (Bun.argv[2] === "serve") {
  const environment = Bun.env[`${identity.environmentPrefix}RELAY_ORIGIN`];
  const statePath = Bun.env[`${identity.environmentPrefix}STATE_PATH`];
  const repositoryId = requiredNumber("REPOSITORY_ID");
  const repositoryOwner =
    Bun.env[`${identity.environmentPrefix}REPOSITORY_OWNER`];
  const repositoryName =
    Bun.env[`${identity.environmentPrefix}REPOSITORY_NAME`];
  // client側停止期限。relayが伝えるserver側失効期限より短い場合だけ所有権を持つ。
  const heartbeatStopMs = requiredNumber("OWNERSHIP_HEARTBEAT_STOP_MS");
  const tokenStore = bunSecretsDeviceTokenStore();
  const conversationReady =
    environment !== undefined &&
    statePath !== undefined &&
    repositoryId !== undefined &&
    repositoryOwner !== undefined &&
    repositoryName !== undefined &&
    heartbeatStopMs !== undefined;
  const httpServer = startServeHttpServer({
    startIssueConversation: conversationReady
      ? ({ issueNumber, body }) =>
          startIssueConversationJob({
            relayOrigin: environment,
            tokenStore,
            // relayの短命installation token発行はまだ無い。認証済みclientを
            // 用意できないため、外部書き込み経路はfail closedにする。
            // 未認証のOctokitは使わない。
            createOctokit: async () => null,
            databasePath: statePath,
            harnessEntry: new URL("./harness.js", import.meta.url),
            repositoryId,
            repository: { owner: repositoryOwner, name: repositoryName },
            issueNumber,
            body,
            heartbeatStopMs,
          })
      : undefined,
    createDeviceRegistration:
      environment === undefined || statePath === undefined
        ? undefined
        : (redirectUri) => {
            const flow = createDeviceRegistrationFlow({
              relay: createRelayDeviceClient({ baseUrl: environment }),
              tokenStore,
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
