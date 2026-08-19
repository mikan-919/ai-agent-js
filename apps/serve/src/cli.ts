import packageManifest from "../../../package.json" with { type: "json" };

import { identity } from "@mikan-919/oriel-identity";

import { bunSecretsDeviceTokenStore } from "./device-registration";
import { createInstanceConfigStore } from "./instance-config";
import { createJobRegistry } from "./job-registry";
import { openServeLocalState } from "./local-state";
import { createModelDefaultsStore } from "./model-defaults";
import { buildServeInstance, type ServeInstanceShared } from "./serve-instance";
import { startServeHttpServer } from "./server";
import { resolveStatePath } from "./state-path";

if (Bun.argv[2] === "--version") {
  console.log(packageManifest.version);
}

function requiredNumber(name: string): number | undefined {
  const value = Number(Bun.env[`${identity.environmentPrefix}${name}`]);

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function environmentVariable(name: string): string | undefined {
  const value = Bun.env[`${identity.environmentPrefix}${name}`];

  return value === undefined || value === "" ? undefined : value;
}

if (Bun.argv[2] === "serve") {
  /**
   * Workflow/Job一覧の唯一の正本。HTTP経由の起動(POST /api/*)とdiscoveryLoop
   * などHTTPを経由しない自立起動の両方が、同じJob起動関数を通じてここへ登録
   * される。instance設定の再構成をまたいでも生き続ける。
   */
  const jobRegistry = createJobRegistry();
  const statePath = resolveStatePath({
    explicitPath: Bun.env[`${identity.environmentPrefix}STATE_PATH`],
    xdgDataHome: Bun.env.XDG_DATA_HOME,
  });
  // client側停止期限。relayが伝えるserver側失効期限より短い場合だけ所有権を持つ。
  const heartbeatStopMs = requiredNumber("OWNERSHIP_HEARTBEAT_STOP_MS");
  // discoveryの定期再読の間隔。運用値は測定と検証専用環境から決めるため既定値を持たない。
  const discoveryPollIntervalMs = requiredNumber("DISCOVERY_POLL_INTERVAL_MS");
  const tokenStore = bunSecretsDeviceTokenStore();
  const modelDefaults = createModelDefaultsStore(
    openServeLocalState(statePath),
  );
  const instanceConfigStore = createInstanceConfigStore(
    openServeLocalState(statePath),
  );

  /**
   * Agent loopが使う提供元とmodelの論理識別子。
   *
   * 利用者固有のlocal設定であり、repositoryの実行設定には置かない。接続先、
   * 認証情報、互換性設定は`serve`だけが持ち、harnessへは渡さない。modelを
   * 利用できない場合は別のmodelへ暗黙に切り替えず実行を止める。
   */
  const modelProviderId = environmentVariable("MODEL_PROVIDER");
  const modelId = environmentVariable("MODEL_ID");
  const configuredModel =
    modelProviderId !== undefined && modelId !== undefined
      ? { provider: modelProviderId, id: modelId }
      : undefined;

  // 既存の環境変数設定は、DBへbaseがまだ無いserveの初回起動時だけ移行する。
  // per-kind設定があればそちらを優先し、以後はSQLiteの値を正本にする。
  if (configuredModel !== undefined && !modelDefaults.isInitialized("base")) {
    modelDefaults.set("base", configuredModel);
  }

  /**
   * relay origin、repositoryなど利用者固有のinstance設定も同じ考え方で、
   * DBがまだ空の初回起動時だけenv varから移行する。以後はSQLiteの値を正本
   * にし、Web UIの初回設定フォームからの保存だけが更新経路になる。
   */
  if (!instanceConfigStore.isInitialized()) {
    instanceConfigStore.set({
      relayOrigin: environmentVariable("RELAY_ORIGIN") ?? null,
      repositoryId: requiredNumber("REPOSITORY_ID") ?? null,
      repositoryOwner: environmentVariable("REPOSITORY_OWNER") ?? null,
      repositoryName: environmentVariable("REPOSITORY_NAME") ?? null,
      // `serve`が担当するrepositoryのcloneと、Jobごとのworktreeを置く領域。
      repositoryRoot: environmentVariable("REPOSITORY_ROOT") ?? null,
      worktreesRoot: environmentVariable("WORKTREES_ROOT") ?? null,
      // Linear webhookのrouting先をrelayへ登録するteam ID。Linear OAuth完了
      // フローが実装されるまでの暫定策であり、運用者がLinear側の設定と合わせ
      // て指定する。
      linearTeamId: environmentVariable("LINEAR_TEAM_ID") ?? null,
      canonicalRemote: environmentVariable("CANONICAL_REMOTE") ?? "origin",
      lmStudioBaseUrl: environmentVariable("LM_STUDIO_BASE_URL") ?? null,
    });
  }

  const shared: ServeInstanceShared = {
    jobRegistry,
    tokenStore,
    statePath,
    heartbeatStopMs,
    discoveryPollIntervalMs,
    modelDefaults,
  };
  let instance = buildServeInstance(instanceConfigStore.get(), shared);

  const httpServer = startServeHttpServer({
    jobRegistry,
    modelProviderId,
    modelId,
    modelDefaults,
    instanceConfigStore,
    // Web UIがinstance設定を保存するたびに、古いinstanceを止めてから同じ
    // プロセス内で新しい配線へ差し替える。プロセスの再起動は発生させない。
    buildInstanceBindings: (config) => {
      instance.stop();
      instance = buildServeInstance(config, shared);

      return instance.bindings;
    },
    ...instance.bindings,
  });

  console.log(httpServer.readinessUrl.toString());
}
