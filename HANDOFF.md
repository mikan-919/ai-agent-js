# 対話ハンドオフ

## 次のセッションへの申し送り

- pi-agent-core/pi-aiのBun互換gateは完了した。v1は`@earendil-works/pi-agent-core@0.84.1`と`@earendil-works/pi-ai@0.84.1`を初期採用版として固定済み。証拠と既知の限界は[docs/research/agent-provider-stack.md](./docs/research/agent-provider-stack.md)、採用ルールは[ROADMAP.md](./ROADMAP.md)「Agentとモデル提供元」を参照。
- 次の実装作業は、ROADMAP.mdの「実装前に決めること」に残る未解決事項を狭めた上で定義する、最小構成のproduction workspaceと最初のtracer bulletである。
- 設計が固まったらGitHub IssueとLinearへ作業を分解し、最初のtracer bulletを人間が承認してから実装する。
