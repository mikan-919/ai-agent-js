# ROADMAP

今nookがどこに向かっているか。優先順位・次のマイルストーン。頻繁に変わってよい。「今何をして・何をしないか」の詳細スコープはFEATURE.md、変わらない思想はCONCEPT.mdを参照。

## 全体アーキテクチャの方向性

- **`nook serve`が中心的インターフェース。** CLI（`nook status`等）はその薄いラッパーとして後回しにする。ただし「薄いラッパー」とは同じロジックを再利用するという意味であり、HTTP経由で起動中の`nook serve`プロセスに問い合わせる、という意味ではない。`resolveWorkContext`等のresolverはサーバ側状態を一切持たない（原則1）ため、CLIはresolverを直接呼び出し、`nook serve`が起動している前提を置かない。
- **Agent loopをHarnessが直接ホストする。** 「既存のhosted agent productにMCP経由で接続するだけの薄いcontext provider」には留まらない。理由はUXの好みではなく、Agentのtool registryをHarnessが完全に所有することで、「Agentに生credentialを渡さない」という境界（CONCEPT.md原則2）をコードの構造で保証できるため。har（旧名）が既存ハーネス（Claude Code等）をラップする「meta-harness」案は検討の上、不採用と確認済み。
- **サーバは概念的に2種類**: 外部（GitHub/Linear）からのwebhookを受ける公開relay（secretを持たない薄い口、v1では未実装）と、Harness Core・credential・Agentセッションを保持するローカル側。
- **v1はpollingのみ。** 起動時/一定間隔で「前回見た状態」との差分を検知すれば十分とし、webhook relayはpollingが実際に不便になった時点で後付けする。
- **GitHub Actionsはagent起動アクターではない。** Agentが`nook serve`内でホストされる以上、GitHub Actions runner上でagentを動かす経路は不要。GitHub Actionsは、リポジトリ自体のtest/build pipeline（`nook status`が結果を読むだけの対象）としての役割のみ。「CI」という語をこの2つの意味で混同しないこと。
- **サンドボックス**: 1 branch(=1作業) = 1サンドボックス（git worktree / Docker、セッション単位で選択可）。`resume`時も同じサンドボックスを再利用する。ロックマネージャ（`refs/harness-locks/<branch>`）とサンドボックス作成は一体化し、サンドボックス作成時にロックを取得する。
- **`POST /agent/run`のタイムアウトはアイドルタイムアウト方式**: 固定の壁時計タイムアウトではなく、「agentが一定時間（デフォルト10分、`NOOK_AGENT_IDLE_TIMEOUT_MS`で上書き可）何のイベントも出さない」ことをハング判定に使う。エージェントが進捗を出し続けている限り実行時間は制限しない。ハング検知時は`Agent.abort()`で中断してエラーを返すのみで、sandbox/lockはそのまま残す（クリーンアップは既存方針どおり別ステップ）。agentのイベント発火は、branch lockのTTL（`refs/harness-locks/<branch>`）を一定間隔（`DEFAULT_TTL_MS`の1/4＝15分ごとにスロットル）で更新するハートビートも兼ねる。これにより、長時間だが生きているrunがTTL切れで他プロセスに横取りされることを防ぐ。
- **sandbox resume時、直前のagent会話transcriptを圧縮して引き継ぐ**: `runAgent`は実行終了時（成功・失敗・タイムアウトいずれでも）に`agent.state.messages`をホスト側`~/.nook/transcripts/<owner>-<repo>/<branch>.json`へ上書き保存する（sandbox内には置かない — worktree/dockerのバックエンド差、および`destroySandbox`の未コミット変更チェックの誤検知を避けるため。蓄積はせず直近1回分のみ保持）。resume時（`sandbox.resumed`かつ保存済みtranscriptがある場合のみ）、pi-agent-coreの`generateSummary`（要約プロンプト・LLM呼び出しは再利用）に渡す前に、thinking blockの除去とtool呼び出し引数の切り詰めを行う機械的圧縮を一段挟んでから要約し、結果を`buildSystemPrompt`の新セクション（`## Previous session in this sandbox`）としてのみ注入する——`WorkContext`型自体には含めない（Git/GitHub/Linear/docsという「外部一次情報の再構成」という意味と、nook自身が生成する要約は別物であるため）。`destroySandbox`はtranscriptファイルもあわせて削除し、sandboxのライフサイクルと一致させる。CONCEPT.mdの「肥大化したconversation historyには依存しない」という文言は変更していない：この判断ロジック（何を根拠にするか）は常にGit/GitHub/Linear/docsの外部一次情報から再構成し、transcriptは代替にしない。会話transcript自体はそれら4ソースのどこにも存在しない一次情報であり、原則3（情報源の複製禁止）には抵触しないという整理。

## 技術スタック

- 言語/ランタイム: TypeScript + Bun + Hono
- 認証情報: resolverはGitHub token / Linear API keyを環境変数（`.env`）から読む（v1はこれで十分。複数リポジトリ横断や`nook serve`常駐化が必要になったら`~/.nook/config`等へ移行）
- **Agent SDK: pi**（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）。provider非依存のtool-callingレイヤー（`Agent`クラス、`pi-agent-core`）を直接使い、`pi-coding-agent`（セッション永続化・拡張機能・TUIを持つインタラクティブCLI向けの上位パッケージ）は使わない——nook自身がsystem promptとtool registryを毎回組み立てるため、そちらの機構は不要かつ原則1（状態は外部に置く）と重複する。LLM自体のprovider/modelは`NOOK_MODEL_PROVIDER`/`NOOK_MODEL_ID`環境変数で切り替え可能（デフォルト: anthropic / claude-sonnet-5）。プロバイダのAPI key（例: `ANTHROPIC_API_KEY`）はpi-ai自身が標準env varから解決し、nookのコードは直接読まない。

## 次の優先順位

1. Agent SDK統合（`POST /agent/run`、pi採用）の実地検証。このセッション環境にはLLM provider側のAPI keyが無く、実際のモデル呼び出しは未検証（sandbox resume時のtranscript要約呼び出しも同様に未検証）。

## 未解決の論点

1. **Agentへdiffを生で渡すか、Harnessが意味的に要約するか**: v1スコープ（ファイル一覧+統計のみ）は確定した。
2. **WorkContextの各ソースキーの詳細フィールドスキーマ**: トップレベルは`git`/`github`/`linear`/`docs`のソース別JSONで確定したが、フィールドレベルは実装しながら詰める。
3. **`resolveGithubContext` / `resolveLinearContext` / lock managerの実GitHub API相手の実地検証**: このセッション環境の`GITHUB_TOKEN`はAPI直叩きに403を返す制約があり未検証。ユーザー自身の環境（本物のPATが使える場所）で一度確認するとよい。
4. **Dockerサンドボックスのデフォルトimage（`oven/bun:1`）は未検証**: テストでは軽量な`alpine/git`で動作確認したのみで、実運用でエージェント実行に足りるかは未確認。このセッション環境ではDockerデーモン自体が起動しておらず検証不可だった。
