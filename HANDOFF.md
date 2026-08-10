# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 次のセッションへの申し送り

- 今回のセッション環境でも実地検証系タスクは前進不可だった: `ANTHROPIC_API_KEY`未設定、`GITHUB_TOKEN`は直叩きに403、Dockerデーモン未起動（`docker`コマンド自体はあるがデーモン未接続）。この制約はセッション環境依存で消えないので、次回も同じ状況なら実地検証はスキップし、ユーザー自身の環境で検証してもらう前提で別のコード設計タスクを拾うこと。
- sandbox resume時のagent会話transcript引き継ぎ（ROADMAP旧・次の優先順位2番目）をgrillingの上で設計・実装し、ROADMAP.md「全体アーキテクチャの方向性」に反映済み。実装は`src/agent/transcript.ts`（保存/読込/削除、pi-agent-coreの`generateSummary`を使った要約）＋`src/agent/run.ts`（resume時の要約注入、実行後の保存）＋`src/sandbox/manager.ts`（destroy時の削除）。**未検証**: `ANTHROPIC_API_KEY`が無いため、実際の要約LLM呼び出し（`summarizePreviousSession`）自体は動かしていない。単体テストは`compressForSummary`（機械的圧縮部分）と保存/読込/削除のround-tripのみ（`src/agent/transcript.test.ts`）。実地検証ができる環境に移ったら、優先順位1番目（Agent SDK統合そのものの実地検証）と合わせてここも確認すること。
