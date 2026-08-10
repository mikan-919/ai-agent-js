# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 直近セッション（2026-08-10）: CLI（`nook status`）実装

`nook status`を追加した。設計判断はgrill-meで確認済み：

- **`nook serve`へのHTTPではなくCLIプロセス内で`resolveWorkContext`を直接呼ぶ**（ROADMAP.mdに理由を追記済み）。
- **このセッションのスコープは`status`のみ**。sandbox（create/destroy）のCLIコマンドは意図的に対象外（次の優先順位に追加済み）。
- 出力は人間向け整形テキストがデフォルト、`--json`で生の`WorkContext`を出力。
- `docs`（CONCEPT.md/ROADMAP.md）は先頭見出し＋最初の段落のみ抜粋（`src/cli/format.ts`）。

## 次のセッションへの申し送り

- 次はROADMAP.md優先順位1番目、sandboxライフサイクル（create/destroy）のCLIコマンド。
- ROADMAP.md未解決論点5（`resolveGithubContext` / `resolveLinearContext` / lock managerの実GitHub API相手の実地検証）は依然未検証。
