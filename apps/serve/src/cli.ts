import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { createGitHubApprovalPorts } from "./github-approval-ports";
import { startImplementationJob } from "./implementation-job";
import { createInstallationGitCredentialResolver } from "./installation-credential";
import { createInstallationOctokitResolver } from "./installation-octokit";
import { startIssueConversationJob } from "./issue-conversation-job";
import {
  bunSecretsLinearToken,
  createLinearApprovalReader,
  createLinearApprovalStateWriter,
} from "./linear-approval";
import { openServeLocalState } from "./local-state";
import { createPendingCancellationStore } from "./pending-cancellations";
import {
  bunSecretsModelCredential,
  createPiModelStreamProvider,
  createServeModels,
} from "./pi-model-provider";
import { createRelayDeviceClient } from "./relay-client";
import { startServeHttpServer } from "./server";

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}

/** Linear tokenを解決できた場合だけ、state反映の境界を作る。 */
async function linearStateWriter(repositoryId: number) {
  const token = await bunSecretsLinearToken(repositoryId).get();

  return token === null ? null : createLinearApprovalStateWriter({ token });
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
  // `serve`が担当するrepositoryのcloneと、Jobごとのworktreeを置く領域。
  const repositoryRoot =
    Bun.env[`${identity.environmentPrefix}REPOSITORY_ROOT`];
  const worktreesRoot = Bun.env[`${identity.environmentPrefix}WORKTREES_ROOT`];
  const canonicalRemote =
    Bun.env[`${identity.environmentPrefix}CANONICAL_REMOTE`] ?? "origin";
  const tokenStore = bunSecretsDeviceTokenStore();
  /**
   * Agent loopが使う提供元とmodelの論理識別子。
   *
   * 利用者固有のlocal設定であり、repositoryの実行設定には置かない。接続先、
   * 認証情報、互換性設定は`serve`だけが持ち、harnessへは渡さない。modelを
   * 利用できない場合は別のmodelへ暗黙に切り替えず実行を止める。
   */
  const modelProviderId =
    Bun.env[`${identity.environmentPrefix}MODEL_PROVIDER`];
  const modelId = Bun.env[`${identity.environmentPrefix}MODEL_ID`];
  const models = createServeModels({
    lmStudioBaseUrl: Bun.env[`${identity.environmentPrefix}LM_STUDIO_BASE_URL`],
  });
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
      conversationReady &&
      repositoryId !== undefined &&
      // worktreeを開けない構成では、実装Jobを始めない。
      repositoryRoot !== undefined &&
      worktreesRoot !== undefined &&
      // modelを選べない構成でも、暗黙の既定値を置かずに始めない。
      modelProviderId !== undefined &&
      modelId !== undefined
        ? ({ linearIssueId }) =>
            startImplementationJob({
              relayOrigin: environment,
              tokenStore,
              // admissionの現在値確認は読み取り権限だけで行う。
              createOctokit: createInstallationOctokitResolver({
                relay: relayDeviceClient,
                tokenStore,
                repositoryId,
                purpose: "admission",
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
              repositoryRoot,
              worktreesRoot,
              remote: canonicalRemote,
              // canonicalブランチへの送信だけに使う一回限りのcredential。
              resolveCredential: createInstallationGitCredentialResolver({
                relay: relayDeviceClient,
                tokenStore,
                repositoryId,
              }),
              model: { provider: modelProviderId, id: modelId },
              // 提供元への接続とcredentialの解決は`serve`の内側だけで行う。
              modelProvider: createPiModelStreamProvider({
                models,
                resolveApiKey: (provider) =>
                  bunSecretsModelCredential(provider).get(),
              }),
              /**
               * 承認後の状態反映は、所有権を確認した`serve`だけがLinearへ行う。
               * tokenはこの内側だけで解決し、harnessへも引数へも渡さない。
               */
              linearApprovalState: {
                readLinearState: async (issueId) => {
                  const writer = await linearStateWriter(repositoryId);

                  return writer === null
                    ? null
                    : writer.readLinearState(issueId);
                },
                moveToTriage: async (issueId) => {
                  const writer = await linearStateWriter(repositoryId);

                  return writer !== null && writer.moveToTriage(issueId);
                },
                moveToInProgress: async (issueId) => {
                  const writer = await linearStateWriter(repositoryId);

                  return writer !== null && writer.moveToInProgress(issueId);
                },
              },
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
              purpose: "issue_conversation",
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
