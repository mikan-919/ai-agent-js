# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 次のセッションへの申し送り

- 今回のセッション環境でも実地検証系タスクは前進不可だった: `ANTHROPIC_API_KEY`未設定、`GITHUB_TOKEN`は直叩きに403、Dockerデーモン未起動。この制約はセッション環境依存で消えないので、次回も同じ状況なら実地検証はスキップし、ユーザー自身の環境で検証してもらう前提で別のコード設計タスクを拾うこと。
- ROADMAP.md/CONCEPT.mdのdrift検出（branch HEADとmain HEADの単純diffにCONCEPT.md/ROADMAP.mdが含まれるかで判定）を実装し、`WorkContext.docs.driftedAgainstMain`として公開、system prompt（`nook serve`のagent向け）と`nook status`（CLI）の両方に警告として表示するようにした。
- 次の設計判断が必要になりそうな点はROADMAP.md「次の優先順位」「未解決の論点」を参照（sandbox resume時のagent会話transcript引き継ぎ、`POST /agent/run`のタイムアウト挙動など）。
