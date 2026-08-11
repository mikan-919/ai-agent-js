# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照(原則1: 状態は外部に置く)。

## 次のセッションへの申し送り

- ROADMAP.mdの次の優先順位3、ticket切り出しagent（`nook ticket`）を実装した（`src/agent/ticketTools.ts`の`create_issue`/`reply_to_issue`、`src/agent/ticketSystemPrompt.ts`、`src/cli/ticket.ts`、`src/index.ts`への`nook ticket`/`nook ticket poll`配線）。設計の詳細（system promptへの埋め込み方式・sandbox都度破棄の理由）はROADMAP.mdの当該項目に反映済み。`bun test`: 97 pass / 7 skip、`bunx tsc --noEmit`・`bun run build:web`ともにクリーン。
- 実GitHub APIでの検証: このセッション環境の`GITHUB_TOKEN`は`GET /user`には応答する（`mikan-919`として認証できることを確認済み）が、`GET /repos/.../issues`には403を返す——論点3として既知の制約が今回も再現した。そのため`create_issue`/`listOpenIssues`/`listProposedIssues`/`reply_to_issue`の実地検証はできていない。ユーザー自身の環境（本物のPATが使える場所）で`nook ticket`を一度通しで確認するとよい。
- `nook ticket poll`はCLIから叩く1回きりのpollingパスとして実装した。`nook serve`内での定期実行（cron相当の自動配線）はまだ行っていない——次にticket切り出しagentへ手を入れるならここが候補になる。
- 論点3〜5（実GitHub token・LLM provider API key・Dockerデーモンが無い制約）はこのセッション環境でも変わらず未解決。
