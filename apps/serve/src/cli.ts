import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { createDiscoveryLoop } from "./discovery";
import {
  createGitHubApprovalPorts,
  createGitHubTargetBaseReader,
} from "./github-approval-ports";
import { createGitHubOpenIssuePort } from "./github-discovery-ports";
import {
  createGitHubPrResponsePorts,
  createGitHubPrResponseReconciliationPorts,
  createGitHubPrResponseReportPorts,
} from "./github-pr-response-ports";
import {
  createGitHubPullRequestMergeCheck,
  createGitHubPullRequestPorts,
} from "./github-pull-request-ports";
import { startHowConfirmationJob } from "./how-confirmation-job";
import { createHowTriggerLoop } from "./how-trigger-discovery";
import { createOctokitIssueCommentPublisher } from "./issue-comments";
import { startImplementationJob } from "./implementation-job";
import { createInstallationGitCredentialResolver } from "./installation-credential";
import { createInstallationOctokitResolver } from "./installation-octokit";
import { startIssueConversationJob } from "./issue-conversation-job";
import { createJobRegistry, holdIfStarted } from "./job-registry";
import {
  bunSecretsLinearToken,
  createLinearApprovalReader,
  createLinearApprovalStateWriter,
  createLinearDiscoveryReader,
} from "./linear-approval";
import { createLinearGraphqlCommentPublisher } from "./linear-comments";
import { createLinearGraphqlDescriptionPublisher } from "./linear-description";
import { createLinearTriageWriter } from "./linear-triage-writer";
import { openServeLocalState } from "./local-state";
import { createNotificationConnection } from "./notification-connection";
import { createPendingCancellationStore } from "./pending-cancellations";
import { createPrMergeDiscoveryLoop } from "./pr-merge-discovery";
import { createPrResponseCheckFailureStore } from "./pr-response-check-failures";
import { createPrResponseLoop } from "./pr-response-discovery";
import { startPrResponseJob } from "./pr-response-job";
import { createPullRequestWatchStore } from "./pull-request-watch";
import {
  bunSecretsModelCredential,
  createPiModelStreamProvider,
  createServeModels,
} from "./pi-model-provider";
import { createRelayDeviceClient } from "./relay-client";
import { startServeHttpServer } from "./server";
import { createTranscriptSearch } from "./transcript-search";
import { createTranscriptStore } from "./transcript-store";
import { startWhatConfirmationJob } from "./what-confirmation-job";
import { createWhatTriggerLoop } from "./what-trigger-discovery";

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
  /**
   * Workflow/Job一覧の唯一の正本。HTTP経由の起動(POST /api/*)とdiscoveryLoop
   * などHTTPを経由しない自立起動の両方が、同じJob起動関数を通じてここへ登録
   * される。
   */
  const jobRegistry = createJobRegistry();
  const environment = Bun.env[`${identity.environmentPrefix}RELAY_ORIGIN`];
  const statePath = Bun.env[`${identity.environmentPrefix}STATE_PATH`];
  const repositoryId = requiredNumber("REPOSITORY_ID");
  const repositoryOwner =
    Bun.env[`${identity.environmentPrefix}REPOSITORY_OWNER`];
  const repositoryName =
    Bun.env[`${identity.environmentPrefix}REPOSITORY_NAME`];
  // client側停止期限。relayが伝えるserver側失効期限より短い場合だけ所有権を持つ。
  const heartbeatStopMs = requiredNumber("OWNERSHIP_HEARTBEAT_STOP_MS");
  // discoveryの定期再読の間隔。運用値は測定と検証専用環境から決めるため既定値を持たない。
  const discoveryPollIntervalMs = requiredNumber("DISCOVERY_POLL_INTERVAL_MS");
  // Linear webhookのrouting先をrelayへ登録するteam ID。Linear OAuth完了フローが
  // 実装されるまでの暫定策であり、運用者がLinear側の設定と合わせて指定する。
  const linearTeamId = Bun.env[`${identity.environmentPrefix}LINEAR_TEAM_ID`];
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
  const implementationReady =
    conversationReady &&
    repositoryId !== undefined &&
    // worktreeを開けない構成では、実装Jobを始めない。
    repositoryRoot !== undefined &&
    worktreesRoot !== undefined &&
    // modelを選べない構成でも、暗黙の既定値を置かずに始めない。
    modelProviderId !== undefined &&
    modelId !== undefined;

  /**
   * 承認されたHOWのLinear Issueからserveが実装Jobを始める、唯一の入口。
   *
   * `/api/implementation-jobs`からの手動起動と、discoveryが発見した候補からの
   * 自動起動の両方がこの同じ関数を呼ぶ。承認、所有権、canonicalブランチ封印の
   * 判断はすべて`startImplementationJob`が現在値から一貫して行う。
   */
  const startImplementation = implementationReady
    ? ({ linearIssueId }: { linearIssueId: string }) =>
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
            const linearToken = await bunSecretsLinearToken(repositoryId).get();

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

              return writer === null ? null : writer.readLinearState(issueId);
            },
            moveToTriage: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer !== null && writer.moveToTriage(issueId);
            },
            moveToInProgress: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer !== null && writer.moveToInProgress(issueId);
            },
            readReviewStateCandidate: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer === null
                ? null
                : writer.readReviewStateCandidate(issueId);
            },
            moveToStateId: async (issueId, stateId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer !== null && writer.moveToStateId(issueId, stateId);
            },
          },
          // Pull Request作成には契約のcontents:write/pull_requests:writeへ絞る。
          createPullRequestOctokit: createInstallationOctokitResolver({
            relay: relayDeviceClient,
            tokenStore,
            repositoryId,
            purpose: "pull_request",
          }),
          createPullRequestPorts: (octokit) =>
            createGitHubPullRequestPorts({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            }),
        }).then((result) =>
          holdIfStarted(jobRegistry, "implementation", result),
        )
    : undefined;

  /**
   * mention/commandトリガーからWHAT確定Jobを始める、唯一の入口。
   *
   * Linear tokenはJob単位でだけ解決し、harnessへは渡さない。
   */
  const whatConfirmationReady =
    conversationReady &&
    modelProviderId !== undefined &&
    modelId !== undefined &&
    linearTeamId !== undefined;
  const startWhatConfirmation =
    whatConfirmationReady && relayDeviceClient !== undefined
      ? ({
          issueNumber,
          trigger,
        }: {
          issueNumber: number;
          trigger: { commentId: number; command: boolean };
        }) =>
          startWhatConfirmationJob({
            relayOrigin: environment,
            tokenStore,
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
            trigger,
            model: { provider: modelProviderId, id: modelId },
            modelProvider: createPiModelStreamProvider({
              models,
              resolveApiKey: (provider) =>
                bunSecretsModelCredential(provider).get(),
            }),
            linearTeamId,
            createLinearPorts: async () => {
              const linearToken =
                await bunSecretsLinearToken(repositoryId).get();

              return linearToken === null
                ? null
                : {
                    linearDiscovery: createLinearDiscoveryReader({
                      token: linearToken,
                    }),
                    linearTriageWriter: createLinearTriageWriter({
                      token: linearToken,
                    }),
                  };
            },
            heartbeatStopMs,
          }).then((result) =>
            holdIfStarted(jobRegistry, "what_confirmation", result),
          )
      : undefined;

  /**
   * mention/commandトリガーからHOW確定Jobを始める、唯一の入口。
   *
   * Linear tokenはJob単位でだけ解決し、harnessへは渡さない。GitHub
   * credentialは使わない(この対話はLinear issueだけを読み書きする)。
   */
  const howConfirmationReady =
    conversationReady && modelProviderId !== undefined && modelId !== undefined;
  const startHowConfirmation =
    howConfirmationReady && relayDeviceClient !== undefined
      ? ({
          issueNumber,
          linearIssueId,
          trigger,
        }: {
          issueNumber: number;
          linearIssueId: string;
          trigger: { commentId: string; command: boolean };
        }) =>
          startHowConfirmationJob({
            relayOrigin: environment,
            tokenStore,
            databasePath: statePath,
            harnessEntry: new URL("./harness.js", import.meta.url),
            repositoryId,
            repository: { owner: repositoryOwner, name: repositoryName },
            issueNumber,
            linearIssueId,
            trigger,
            model: { provider: modelProviderId, id: modelId },
            modelProvider: createPiModelStreamProvider({
              models,
              resolveApiKey: (provider) =>
                bunSecretsModelCredential(provider).get(),
            }),
            createLinearPorts: async () => {
              const linearToken =
                await bunSecretsLinearToken(repositoryId).get();

              if (linearToken === null) {
                return null;
              }

              const reader = createLinearApprovalReader({ token: linearToken });

              return {
                reader,
                commentPublisher: createLinearGraphqlCommentPublisher({
                  token: linearToken,
                }),
                descriptionPublisher: createLinearGraphqlDescriptionPublisher({
                  token: linearToken,
                  reader,
                }),
              };
            },
            heartbeatStopMs,
          }).then((result) =>
            holdIfStarted(jobRegistry, "how_confirmation", result),
          )
      : undefined;

  const transcripts =
    statePath === undefined
      ? undefined
      : createTranscriptStore(openServeLocalState(statePath));
  // repository scopeの検索が中継先へ届く接続。webhook通知loopと共に後で開く。
  let notificationConnection: ReturnType<
    typeof createNotificationConnection
  > | null = null;
  const searchTranscripts =
    transcripts !== undefined &&
    repositoryOwner !== undefined &&
    repositoryName !== undefined
      ? createTranscriptSearch(
          transcripts,
          {
            searchRepository: (request) =>
              notificationConnection?.searchRepository(request) ??
              Promise.resolve([]),
          },
          { owner: repositoryOwner, name: repositoryName },
        )
      : undefined;

  const httpServer = startServeHttpServer({
    jobRegistry,
    searchTranscripts,
    startImplementationJob: startImplementation,
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
          }).then((result) =>
            holdIfStarted(jobRegistry, "issue_conversation", result),
          )
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

  /**
   * webhook通知と定期ポーリングから、実装JobとWHAT確定Jobの両方の候補を発見する。
   * 実装Jobを始められる構成(`implementationReady`)とWHAT確定Jobを始められる
   * 構成(`whatConfirmationReady`)は独立に、discoveryのpoll間隔とLinear team両方
   * を明示した場合だけそれぞれ配線する。wake通知は一本のnotification connection
   * から両方のloopへ配る。
   */
  const discoveryLoop =
    implementationReady &&
    startImplementation !== undefined &&
    relayDeviceClient !== undefined &&
    discoveryPollIntervalMs !== undefined &&
    linearTeamId !== undefined
      ? createDiscoveryLoop({
          createPorts: async () => {
            const octokit = await createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "admission",
            })();

            if (octokit === null) {
              return null;
            }

            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            if (linearToken === null) {
              return null;
            }

            const openIssues = createGitHubOpenIssuePort({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            });
            const discoveryReader = createLinearDiscoveryReader({
              token: linearToken,
            });

            return {
              listOpenIssues: () => openIssues.listOpenIssues(),
              findLinearIssuesByGitHubIssueUrl: (url) =>
                discoveryReader.findIssuesByAttachmentUrl(url),
            };
          },
          startImplementationJob: startImplementation,
          pollIntervalMs: discoveryPollIntervalMs,
        })
      : undefined;
  const whatTriggerLoop =
    whatConfirmationReady &&
    startWhatConfirmation !== undefined &&
    relayDeviceClient !== undefined &&
    discoveryPollIntervalMs !== undefined &&
    linearTeamId !== undefined
      ? createWhatTriggerLoop({
          createPorts: async () => {
            const octokit = await createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "admission",
            })();

            if (octokit === null) {
              return null;
            }

            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            if (linearToken === null) {
              return null;
            }

            const comments = createOctokitIssueCommentPublisher(octokit);
            const openIssues = createGitHubOpenIssuePort({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            });
            const discoveryReader = createLinearDiscoveryReader({
              token: linearToken,
            });

            return {
              listOpenIssues: () => openIssues.listOpenIssues(),
              listIssueComments: (issueNumber) =>
                comments
                  .listIssueComments({
                    repository: {
                      owner: repositoryOwner,
                      name: repositoryName,
                    },
                    issueNumber,
                  })
                  .catch(() => null),
              getActorLogin: () => comments.getActorLogin(),
              findLinearIssuesByGitHubIssueUrl: (url) =>
                discoveryReader.findIssuesByAttachmentUrl(url),
            };
          },
          startWhatConfirmationJob: startWhatConfirmation,
          pollIntervalMs: discoveryPollIntervalMs,
        })
      : undefined;
  const howTriggerLoop =
    howConfirmationReady &&
    startHowConfirmation !== undefined &&
    relayDeviceClient !== undefined &&
    discoveryPollIntervalMs !== undefined
      ? createHowTriggerLoop({
          createPorts: async () => {
            const octokit = await createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "admission",
            })();

            if (octokit === null) {
              return null;
            }

            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            if (linearToken === null) {
              return null;
            }

            const openIssues = createGitHubOpenIssuePort({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            });
            const discoveryReader = createLinearDiscoveryReader({
              token: linearToken,
            });
            const reader = createLinearApprovalReader({ token: linearToken });
            const comments = createLinearGraphqlCommentPublisher({
              token: linearToken,
            });

            return {
              listOpenIssues: () => openIssues.listOpenIssues(),
              findLinearIssuesByGitHubIssueUrl: (url) =>
                discoveryReader.findIssuesByAttachmentUrl(url),
              readLinearIssue: (linearIssueId) =>
                reader.readIssue(linearIssueId),
              listLinearComments: (linearIssueId) =>
                comments.listComments({ linearIssueId }).catch(() => null),
              getLinearViewerId: () => comments.getViewerId().catch(() => null),
            };
          },
          startHowConfirmationJob: startHowConfirmation,
          pollIntervalMs: discoveryPollIntervalMs,
        })
      : undefined;

  /**
   * ADR 0005「Linear状態」のとおり、mergeを現在値から確認した後にLinearを
   * Doneへ反映する。webhookは起床通知に過ぎず、pollingが最終的な正しさを担う。
   */
  const prMergeLoop =
    implementationReady &&
    relayDeviceClient !== undefined &&
    discoveryPollIntervalMs !== undefined &&
    statePath !== undefined
      ? (() => {
          const database = openServeLocalState(statePath);

          return createPrMergeDiscoveryLoop({
            createPorts: async () => {
              const octokit = await createInstallationOctokitResolver({
                relay: relayDeviceClient,
                tokenStore,
                repositoryId,
                purpose: "pull_request",
              })();

              if (octokit === null) {
                return null;
              }

              const writer = await linearStateWriter(repositoryId);

              if (writer === null) {
                return null;
              }

              const merges = createGitHubPullRequestMergeCheck({
                octokit,
                repository: { owner: repositoryOwner, name: repositoryName },
              });

              return {
                isPullRequestMerged: (prNumber) =>
                  merges.isPullRequestMerged(prNumber),
                readLinearState: (issueId) => writer.readLinearState(issueId),
                moveToDone: (issueId) => writer.moveToDone(issueId),
              };
            },
            database,
            watchStore: createPullRequestWatchStore(database),
            pollIntervalMs: discoveryPollIntervalMs,
          });
        })()
      : undefined;

  /**
   * ADR 0007のPR対応Job。実装Jobと同じ構成が揃っている場合だけ動かし、Linear
   * credentialは要求しない(このJobはLinearを一切触らない)。
   */
  const prResponseLoop =
    implementationReady &&
    relayDeviceClient !== undefined &&
    discoveryPollIntervalMs !== undefined &&
    statePath !== undefined
      ? (() => {
          const database = openServeLocalState(statePath);
          const checkFailures = createPrResponseCheckFailureStore(database);
          const repository = { owner: repositoryOwner, name: repositoryName };
          const createPrResponseOctokit = createInstallationOctokitResolver({
            relay: relayDeviceClient,
            tokenStore,
            repositoryId,
            purpose: "pr_response",
          });

          return createPrResponseLoop({
            createPorts: async () => {
              const octokit = await createPrResponseOctokit();

              if (octokit === null) {
                return null;
              }

              const actorLogin = await octokit.rest.users
                .getAuthenticated()
                .then((response) => response.data.login)
                .catch(() => null);

              if (actorLogin === null) {
                return null;
              }

              return createGitHubPrResponsePorts({
                octokit,
                repository,
                actorLogin,
              });
            },
            repositoryId,
            checkFailures,
            startPrResponseJob: ({
              prNumber,
              headRef,
              headOid,
              githubIssueNumber,
              approvalFingerprint,
              trigger,
            }) =>
              startPrResponseJob({
                relayOrigin: environment,
                tokenStore,
                databasePath: statePath,
                harnessEntry: new URL("./harness.js", import.meta.url),
                repositoryId,
                repository,
                heartbeatStopMs,
                repositoryRoot,
                worktreesRoot,
                remote: canonicalRemote,
                resolveCredential: createInstallationGitCredentialResolver({
                  relay: relayDeviceClient,
                  tokenStore,
                  repositoryId,
                }),
                model: { provider: modelProviderId, id: modelId },
                modelProvider: createPiModelStreamProvider({
                  models,
                  resolveApiKey: (provider) =>
                    bunSecretsModelCredential(provider).get(),
                }),
                createExecutionConfigPorts: async () => {
                  const octokit = await createInstallationOctokitResolver({
                    relay: relayDeviceClient,
                    tokenStore,
                    repositoryId,
                    purpose: "admission",
                  })();

                  return octokit === null
                    ? null
                    : createGitHubTargetBaseReader({ octokit, repository });
                },
                createReconciliationPorts: async () => {
                  const octokit = await createPrResponseOctokit();

                  return octokit === null
                    ? null
                    : createGitHubPrResponseReconciliationPorts({
                        octokit,
                        repository,
                      });
                },
                createReportPorts: async () => {
                  const octokit = await createPrResponseOctokit();

                  return octokit === null
                    ? null
                    : createGitHubPrResponseReportPorts({
                        octokit,
                        repository,
                      });
                },
                checkFailures,
                prNumber,
                headRef,
                headOid,
                githubIssueNumber,
                approvalFingerprint,
                trigger,
              }).then((result) =>
                holdIfStarted(jobRegistry, "pr_response", result),
              ),
            pollIntervalMs: discoveryPollIntervalMs,
          });
        })()
      : undefined;

  if (
    (discoveryLoop !== undefined ||
      whatTriggerLoop !== undefined ||
      howTriggerLoop !== undefined ||
      prMergeLoop !== undefined ||
      prResponseLoop !== undefined) &&
    repositoryId !== undefined &&
    environment !== undefined
  ) {
    if (linearTeamId !== undefined && relayDeviceClient !== undefined) {
      void (async () => {
        const deviceToken = await tokenStore.get(repositoryId);

        if (deviceToken !== null) {
          await relayDeviceClient.registerLinearRouting(
            deviceToken,
            linearTeamId,
          );
        }
      })();
    }

    discoveryLoop?.start();
    whatTriggerLoop?.start();
    howTriggerLoop?.start();
    prMergeLoop?.start();
    prResponseLoop?.start();

    notificationConnection = createNotificationConnection({
      relayOrigin: environment,
      resolveDeviceToken: () => tokenStore.get(repositoryId),
      onWake: (source) => {
        void discoveryLoop?.wake(source);
        void whatTriggerLoop?.wake(source);
        void howTriggerLoop?.wake(source);
        void prMergeLoop?.wake(source);
        void prResponseLoop?.wake(source);
      },
      onTranscriptSearchRequest: (request) =>
        transcripts === undefined ||
        repositoryOwner === undefined ||
        repositoryName === undefined
          ? []
          : transcripts.search({
              repository: { owner: repositoryOwner, name: repositoryName },
              scope: request.scope === "job" ? "job" : "local",
              jobId: request.jobId,
              query: request.query,
              limit: request.limit,
            }),
    });
  }

  console.log(httpServer.readinessUrl.toString());
}
