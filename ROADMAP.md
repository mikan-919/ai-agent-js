# ROADMAP

この文書は、分散実行モデルのアーキテクチャを固めるまで、設計方向と未解決事項を保持する。共有ROADMAPを恒久的なJob入力にはしない。実装を始める前に未解決事項をGitHub Issueへ分解し、以後の優先順位はGitHub IssueとLinearのviewで管理する。

## 移行するアーキテクチャ

```text
GitHub Issue (WHAT / Workflow ID)
        │
        ▼
Linear issue (HOW / Triage→Todo approval)
        │ webhook
        ▼
public relay
        │ notification / short-lived token
        ▼
repository-scoped local serve instances
        │ Job lease + canonical branch lock (code-changing Job only)
        ▼
local Agent / worktree
        │ checkpoint / push / PR
        ▼
GitHub Pull Request (DO / merge approval)
```

### v1の実装単位とruntime

repositoryはTypeScriptのBun workspaceとし、次のruntime単位へ分ける。

```text
apps/relay       Cloudflare Workers + Durable Objects
apps/serve       credentialとlocal stateを持つBun process
apps/harness     credentialを持たないJob単位のBun process
packages/contracts
                 IPC、event、設定schemaと共有型
packages/identity
                 製品名、CLI名、User-Agent、状態領域、環境変数接頭辞、ラベル
```

- local runtimeの対象はLinuxとWSL2とする。native macOSとnative Windowsはv1の対象にしない。
- package manager、local build、local test、CLI bundleにはBunを使う。Cloudflare上ではWorkers runtimeを使い、Bun互換を仮定しない。
- 表示名は`Oriel`、コード識別子とCLI名は`oriel`、npm packageは`@mikan-919/oriel`、環境変数接頭辞は`ORIEL_`とする。識別情報は`packages/identity`だけを正本にする。
- root `package.json`のversionを配布物のversionの正本とし、内部packageは個別に公開しない。

### server、contract、process間通信

- `serve`と`relay`のHTTP routerにはHonoを使う。`serve`は`Bun.serve({ fetch: app.fetch })`、`relay`はWorkersの`fetch`として動かす。
- HTTPとIPCのruntime validationにはValibotの`strictObject`を使う。wire schemaではtransform、default、coercionを行わず、検証後に正規化する。
- Honoでは`@hono/standard-validator`を介してValibotを使う。routeと認証middlewareは共有せず、`packages/contracts`のschemaと型だけを共有する。
- `serve`がJobごとの`harness`をchild processとして起動する。stdin/stdoutのNDJSONをIPCとし、stdinへmodel要求、中止、tool結果、stdoutへstreamとlifecycle event、stderrへ人間向けlogを流す。
- IPC messageは`requestId`と`type`を持つ。切断したturnは`interrupted`として保存し、v1ではprocess再接続protocolを設けない。
- 通常commandとsystem Gitはshell文字列を介さず、引数配列を渡す`Bun.spawn`で実行する。対話操作だけ`Bun.Terminal`を使う。
- GitHubとLinearのremote操作は`serve`、status、diff、commit、worktree操作はharness側の薄いsystem Git adapterが担当する。tokenを引数、remote URL、環境変数としてharnessへ渡さない。

### Web UI

- `serve`がReact 19、Vite、Tailwind CSS 4、shadcn/uiとBase UIによるCSR SPAを配信する。SSR、RSC、server functionを導入しない。
- routeとURL stateにはfile-based TanStack Routerを使い、search parameterをValibotで検証する。HTTP由来のserver stateにはTanStack Query、実行中WebSocket streamにはsession専用の小さなmemory store、局所状態にはReact stateを使う。
- 汎用global storeは置かない。必要性が実例で確認された場合の最初の候補をJotaiとする。
- Markdownは`react-markdown`と`remark-gfm`で描画し、生HTMLを解釈しない。codeはShikiのfine-grained bundleをWeb Workerで遅延loadする。
- Git diffは`react-diff-view`、対話terminalは`@xterm/xterm`で表示する。通常commandのstdout/stderrは`pre`で表示し、xtermを使わない。

### local data、検索、Job制御

- local stateとtranscriptは`bun:sqlite`とDrizzleで管理し、SQL migrationをrepositoryへ置く。WALを有効にし、複雑なqueryにはraw SQLを使えるようにする。
- transcript検索は同じSQLite DBのFTS5 `trigram` indexを使う。repository、Job、期間などの範囲は通常列で絞り、3文字未満のqueryだけ`LIKE`へfallbackする。
- embedding、vector DB、外部検索serviceはv1へ入れない。remote検索では各`serve`が自分のlocal indexを検索し、relayはqueryと結果をstreamするだけとする。
- Jobの状態とeventはTypeScriptの判別unionで表し、`transition(currentState, event)`を副作用のない関数にする。許可された遷移とidempotency key付きoutboxをSQLite transaction内で保存し、外部操作はcommit後に実行する。
- 再起動時は保存済み状態と未処理outboxから再開する。XState、Cloudflare Workflows、Temporal、BullMQはv1へ入れない。

### 公開relay

- Honoを使うCloudflare Workerと、GitHub App installation＋repositoryをkeyとするSQLite-backed Durable Objectだけで構成する。
- WebSocketにはDurable ObjectsのHibernation APIを使う。WebSocketそのものはHonoで抽象化せず、WorkersとDurable Objectsのnative APIを使う。
- GitHub App webhookとLinear webhookを受ける。
- GitHub App秘密鍵を保持し、repositoryと権限を絞った短命installation tokenを発行する。
- Linear OAuth＋PKCEのcallbackをローカル`serve`へ中継する。
- 接続中`serve`への状態変更通知とtranscript検索要求を中継する。
- Job DB、scheduler、コード、transcript、Agent sessionは保存しない。
- 初期は独自アカウントを持たず、GitHub App installationを利用単位とする。
- 永続化するのはdevice tokenのhashと表示用metadata、repository認可、routingに必要なIDだけとする。D1、KV、R2はv1で使わない。

### ローカル`serve`

- 一つのrepositoryを担当する。
- 初回にブラウザで人間が登録・承認する。
- GitHub短命tokenとLinear OAuth tokenをOSのcredential storeへ保存する。
- Web UIをlocalhostで提供する。
- harnessの環境変数、引数、tool入力へcredentialを渡さず、外部操作を専用toolとして提供する。
- webhookを逃した場合はGitHub・Linearの現在状態を読み直す。
- GitHub APIにはOctokit、Linear APIには`@linear/sdk`を使う。relay側のLinear OAuth交換は`fetch`、webhook署名検証はraw bodyとWeb Cryptoで実装する。
- provider、GitHub、Linearのcredentialは`Bun.secrets`へ保存する。Linux/WSL2のSecret Serviceが利用できない場合はfail closedとし、平文file、SQLite、環境変数へfallbackしない。
- operational logはstructured NDJSONとしてstderrとrotation付きlocal fileへ出し、Web UIから直近分を見られるようにする。relayはstructured JSONをWorkers Logsへ出す。transcriptとcredential、prompt、response、tool結果はoperational logへ含めず、外部observability serviceもv1へ入れない。

### Workflowの発見とJobの取得

- GitHub Issue URLをLinear attachment APIへ渡し、対応するLinear issueを逆引きする。
- 対応するLinear issueが一つだけでTodoの場合に、[ADR 0003](./docs/adr/0003-approval-admission-and-reconciliation.md)の現在値確認を通ったWorkflowだけからJobの実行候補を導出する。
- すべてのJobはJob leaseを取得し、コードを変更するJobだけがcanonical branch lockも取得する。必要な所有権を取得できなければ実行しない。
- activeなcanonical branchとPull RequestはWorkflowごとに一つだけとする。

### 外部phaseとJob execution

- GitHub、Linear、Pull Requestのcurrent stateからWorkflow phaseを導出し、local Job stateをその複製にしない。
- Job execution state、Job lease、canonical branch lock、外部操作前のownership checkは[ADR 0002](./docs/adr/0002-job-ownership-and-execution-state.md)を正本とする。
- LinearのTriageからTodoへの承認を実装Job候補へ導き、所有権取得の前後で二度一致した現在のWHAT/HOWからapproval fingerprintを計算し、canonical branchをfingerprint由来の名前として扱う方針は[ADR 0003](./docs/adr/0003-approval-admission-and-reconciliation.md)を正本とする。本文やhistory snapshotを複製せず、native historyの完全性は実行条件にしない。
- state、attachment、WHAT/HOW、fingerprint、またはbranch seal中のbaseの不一致を観測すれば旧Jobを停止する。承認対象の不一致では、current leaseと対象Workflowを確認した`serve`がTodoをTriageへ戻す。fresh Triage→Todoでfingerprintが同じなら、先行worker/ownership/active PRを解消し、既存branch tipが安全なcheckpoint/known writeだと証明できる場合だけ同じ論理Jobとbranchをadoptする。fingerprintが変わるWHAT/HOW改訂ならnew Jobとnew canonical branchを作る。branch takeoverと差し戻しwriteのoperation-specific reconciliationは未解決である。PR merge後はLinearをDoneへ更新し、復元可能でcleanなsandboxを削除する。

### checkpointと履歴

- Agentは安定点でcheckpoint commitとHANDOFF.mdをpushする。
- PRをreadyにする前にHANDOFF.mdを削除する。
- transcriptはsandboxと分離してローカルに保存し、自動削除しない。
- local、current Job、repositoryの範囲で、接続中`serve`間の検索を可能にする。

### 実行環境

- v1の実行backendは`WorktreeBackend`だけとする。Docker、Podman、Nix、Dev Containerのadapterとruntime検証はv1へ入れない。
- worktreeはJob間のcheckout分離であり、host filesystemや同一userのprocessに対する強いsecurity sandboxではない。credentialをharnessの環境変数、引数、tool入力へ明示的に渡さないことは維持する。
- repository rootの`.oriel.yaml`を実行設定の正本とし、YAML 1.2を`yaml` packageでparseした後、Valibotのstrict schemaで検証する。Valibot schemaからeditor用JSON Schemaを生成する。
- 設定は`schemaVersion: 1`、`execution.backend: worktree`、`execution.autonomous: true`を明示した場合だけ、worktreeで自立Jobを開始できる。欠落、未知field、未知versionはfail closedにする。
- 実行可能なTypeScript設定、環境変数展開、YAML custom tagは許可しない。provider ID、model ID、credentialなど利用者固有のlocal設定をrepositoryへ保存しない。
- 実行時はPull Requestのtarget branch上にある設定だけを信頼し、Agentがworking branchで変更した設定をそのJobへ適用しない。

### Agentとモデル提供元

- 認証情報を持たない実行ハーネスで`@earendil-works/pi-agent-core`によるAgentの反復処理とツール実行を動かす。
- 信頼されたローカル`serve`で`@earendil-works/pi-ai`による提供元への接続、認証情報の解決、モデル選択を担う。
- 実行ハーネスは提供元とモデルの論理的な識別子だけを指定する。接続先、認証情報、互換性設定の正本は`serve`に置く。
- モデルを利用できない場合は、別のモデルへ暗黙に切り替えず実行を止める。
- プロセス間は`pi-agent-core`が受け取る`StreamFn`を境界とし、pi-aiのstream eventを別形式へ変換しない。IPCは要求の対応付け、event配送、中止、切断検知だけを加える。
- LM Studioは`serve`側の暫定接続部で対応する。pi-aiの公式providerが利用可能になった後、同じ検証を通過した版へ更新するときに暫定接続部を削除して置き換える。
- transcriptは`serve`が所有する単一の時系列記録とし、モデルからのstreamと実行ハーネス側のAgent lifecycle・ツール実行eventを統合する。provider eventを別の正本として二重保存しない。
- プロセス切断時は進行中のturnを`interrupted`として記録する。受信済みeventは残すが、未完了のassistant messageを次のmodel contextへ入れず、モデルへの要求と完了未確認のtool callを自動再実行しない。
- v1は`@earendil-works/pi-agent-core@0.84.1`と`@earendil-works/pi-ai@0.84.1`を、Bun互換gate（text、thinking、tool call引数の差分、ツール実行後の次のturn、中止、IPC経由のstream、LM Studio暫定provider）に合格した初期採用版として固定する。gateの証拠と既知の限界は[docs/research/agent-provider-stack.md](./docs/research/agent-provider-stack.md)を正本とする。
- 版を上げる場合は、新しい版で同じBun互換gateを再度通過させてから切り替える。

### device登録とlocalhost境界

- device登録にはrepository scopeのCSPRNG bearer tokenを使う。relayはhashと表示用metadataだけを保存し、`serve`はtokenを`Bun.secrets`へ保存する。
- 初回登録はlocalhost UIからGitHub login、App installationとrepository選択を行い、relayが返す一回限りの短命codeを`serve`がdevice tokenへ交換する。tokenをURLへ載せず、copy-and-pasteも要求しない。
- tokenはdevice単位で失効できるようにする。v1ではrotation protocolを設けず、削除後の再登録で交換する。
- `serve`は`127.0.0.1`のOS割当portだけで待ち受ける。起動ごとのsession cookieを`HttpOnly; SameSite=Strict; Path=/`で設定し、永続化しない。
- `Host`と`Origin`を完全一致で検証し、状態変更APIにはCSRF token付きcustom headerを要求する。GETは状態を変更せず、CORSとiframe埋め込みを許可しない。WebSocketにも同じOrigin、session、CSRF検査を適用する。

### 配布、品質、test

- npm packageにはBun shebang付きの`dist/cli.js`、Vite buildの`dist/web/`、Drizzle SQLの`dist/migrations/`を含める。persistent dataはbunx cacheではなくOS application data領域へ置く。
- 試用は`bunx @mikan-919/oriel serve`、再現可能な実行はexact version付きの`bunx @mikan-919/oriel@<version> serve`とする。Node runtime、postinstall、global install、自動updateはv1で要求しない。
- local packageのquality gateはESLint 9 flat config、typescript-eslint、`eslint-plugin-react-hooks`、`@tanstack/eslint-plugin-router`、Prettier、`prettier-plugin-tailwindcss`、`tsc --noEmit`とする。
- `serve`、`harness`、contract、SQLiteは`bun:test`、relayとDurable ObjectsはVitestと`@cloudflare/vitest-pool-workers`、browser E2EはPlaywrightのChromiumで検証する。React Testing Libraryはcomponent境界で必要性が確認された時に追加し、coverage率は根拠なく設定しない。
- GitHub Actionsで固定Bun版とfrozen lockfileを使い、lint、format check、typecheck、test、buildを行う。保護されたrelease tagではrelayをWranglerでdeployしてsmoke testした後、npm OIDC trusted publishingでCLIを公開する。
- npm publishに必要な公式npm CLIだけはrelease jobのNode上で動かす。製品runtimeはBun-onlyを維持し、Changesetsや独自release automationを追加しない。

## 文書構成

- 「する／しない」はCONCEPT.mdを正本とし、FEATURE.mdはその配置を示すためだけに残す。
- ROADMAP.mdは設計中の論点に限って使い、実装タスクはGitHub IssueとLinearへ移す。
- HANDOFF.mdは現在の設計セッションから再開するための情報だけを持つ。

## 実装前に決めること

- Job lease refの形式、期限、heartbeat、引き継ぎ手順
- 同fingerprintのfresh approvalが既存canonical branchをadoptできる安全なcheckpoint/known-write証明と、operation-specific branch takeover/reconciliation protocol。
- draft PRを作る時点とcheckpoint頻度を調整するAgent prompt
- relay、serve、harness、worktree間のtool APIの詳細
- 障害、再接続、二重実行、途中再開を含むreconciliation手順
- 最小構成で端から端まで成立させる最初のtracer bullet

## 設計を固める順序

1. コンポーネントの責務と信頼境界を図とinterfaceで定義する。
2. Jobの状態遷移、lease、branch lockの不変条件を定義する。完了（[ADR 0002](./docs/adr/0002-job-ownership-and-execution-state.md)）。
3. GitHub・Linear・relay・serve間のイベントとreconciliationを時系列で定義する。現在値の二重確認、承認指紋、branch seal、観測した不一致でTriageへ戻す手順はAccepted（[ADR 0003](./docs/adr/0003-approval-admission-and-reconciliation.md)）だが、対話、PR、その他の外部writeの個別protocolは未解決。
4. credential、認証、認可、token受け渡しを脅威モデルとともに定義する。
5. checkpoint、transcript、worker引き継ぎの保存・検索境界を定義する。
6. capability schemaと実行環境選択を定義する。
7. 決定事項をGitHub Issueへ分解し、最初のtracer bulletを承認してから実装を開始する。
