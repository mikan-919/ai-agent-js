# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 直近セッション（2026-08-10）: CLI（`nook sandbox create/destroy`）実装

`nook status`と同じ設計方針（サーバへのHTTPではなくCLIプロセス内で`createSandbox`/`destroySandbox`を直接呼ぶ）を踏襲し、sandboxライフサイクルのCLIコマンドを追加した。既存の`sandbox/manager.ts`が必要な入出力をすべて確定済みだったため、grill-meが必要な未解決の設計判断はなかった。

- コマンド形状: `nook sandbox create <branch> [--backend worktree|docker] [--json]` / `nook sandbox destroy <branch> [--backend worktree|docker] [--force] [--json]`。
- token取得は`resolveGithubContext`と同じ規約（`GITHUB_TOKEN`環境変数）。
- `holder`/`baseDir`/`image`/`ttlMs`/`note`はCLIフラグとして露出せず、manager側のデフォルトに委ねた（今すぐ必要な理由がないため、YAGNI）。
- 出力は`status`と同様、人間向け整形テキストがデフォルト、`--json`で生の`CreateSandboxResult`/`DestroySandboxResult`を出力。

## 次のセッションへの申し送り

- 次はROADMAP.md優先順位1番目、Agent SDK統合。ROADMAP.md未解決論点1（Claude Agent SDK か Codex SDK か）が前提として未確定なので、着手前にgrill-meで方針を確認すること。
- ROADMAP.md未解決論点5（`resolveGithubContext` / `resolveLinearContext` / lock managerの実GitHub API相手の実地検証）は依然未検証。
