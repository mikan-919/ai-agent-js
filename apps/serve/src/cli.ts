import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { createGitHubApprovalPorts } from "./github-approval-ports";
import { startImplementationJob } from "./implementation-job";
import { createInstallationOctokitResolver } from "./installation-octokit";
import { startIssueConversationJob } from "./issue-conversation-job";
import {
  bunSecretsLinearToken,
  createLinearApprovalReader,
} from "./linear-approval";
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
  const relayDeviceClient =
    environment === undefined
      ? undefined
      : createRelayDeviceClient({ baseUrl: environment });
  const conversationReady =
    relayDeviceClient !== undefined &&
    environment !== undefined &&
    statePath !== undefined &&
    repositoryId !== undefined &&
    repositoryOwner !== undefined &&
    repositoryName !== undefined &&
    heartbeatStopMs !== undefined;
  const httpServer = startServeHttpServer({
    startImplementationJob:
      conversationReady && repositoryId !== undefined
        ? ({ linearIssueId }) =>
            startImplementationJob({
              relayOrigin: environment,
              tokenStore,
              createOctokit: createInstallationOctokitResolver({
                relay: relayDeviceClient,
                tokenStore,
                repositoryId,
              }),
              // HOWの正本へ届かないなら、実装Jobを始めない。
              createPorts: async (octokit) => {
                const linearToken =
                  await bunSecretsLinearToken(repositoryId).get();

                return linearToken === null
                  ? null
                  : createGitHubApprovalPorts({
                      octokit,
                      repository: {
                        owner: repositoryOwner,
                        name: repositoryName,
                      },
                      linear: createLinearApprovalReader({
                        token: linearToken,
                      }),
                    });
              },
              databasePath: statePath,
              harnessEntry: new URL("./harness.js", import.meta.url),
              repositoryId,
              repository: { owner: repositoryOwner, name: repositoryName },
              linearIssueId,
              heartbeatStopMs,
            })
        : undefined,
    startIssueConversation: conversationReady
      ? ({ issueNumber, body }) =>
          startIssueConversationJob({
            relayOrigin: environment,
            tokenStore,
            // 外部書き込みは、relayが発行するrepository限定の短命installation
            // tokenで認証したOctokitだけで行う。未認証clientは使わない。
            createOctokit: createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
            }),
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
      environment === undefined ||
      statePath === undefined ||
      relayDeviceClient === undefined
        ? undefined
        : (redirectUri) => {
            const flow = createDeviceRegistrationFlow({
              relay: relayDeviceClient,
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
