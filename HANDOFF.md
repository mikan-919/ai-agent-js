# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照(原則1: 状態は外部に置く)。

## 次のセッションへの申し送り

- HANDOFF.mdの前回の申し送りにあった「`nook serve`内での定期実行（cron相当の自動配線）」を実装した。`nook ticket`/`nook ticket poll`の中身（抽出パス・pollパス）を`src/agent/ticketRun.ts`の`runTicketExtractionPass`/`runTicketPollPass`へ切り出し、CLI（`src/index.ts`）と`nook serve`（`src/serve.ts`）の両方がこれを呼ぶ構成にした。`nook serve`側は`NOOK_TICKET_POLL_INTERVAL_MS`が設定されているときだけ有効になるopt-in（デフォルト無効）——理由・多重実行防止（`runInProgress`フラグ）の詳細はROADMAP.mdのticket切り出しagent項目に反映済み。`bun test`: 101 pass / 7 skip（新規テストは`src/agent/ticketRun.test.ts`、`runTicketExtractionPass`/`runTicketPollPass`のno-remoteエラー経路・skip経路・sandbox失敗時のper-issueエラー記録経路をfetchモックでカバー）、`bunx tsc --noEmit`・`bun run build:web`ともにクリーン。
- 実GitHub API・LLM providerでの通し検証はまだできていない——このセッション環境の`GITHUB_TOKEN`が`GET /repos/.../issues`に403を返す制約（論点3）とLLM provider側API keyが無い制約（論点5と同種）が今回も残っている。`NOOK_TICKET_POLL_INTERVAL_MS`を設定した`nook serve`を、本物のGITHUB_TOKEN・LLM provider API keyが使える環境で一度通しで動かし、抽出パス→pollパスが実際にIssue作成・返信まで届くか確認するとよい。
- 論点3〜5（実GitHub token・LLM provider API key・Dockerデーモンが無い制約）はこのセッション環境でも変わらず未解決。
