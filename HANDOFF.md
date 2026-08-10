# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 直近セッション（2026-08-10）: ドキュメント整理

HANDOFF.mdが複数セッション分の設計確定・実装ログを無限追記して肥大化し、CONCEPT.mdが参照するROADMAP.md/FEATURE.mdが実体を持たない矛盾を抱えていた。ユーザーへのgrillで以下を確定し、実行した。

- **HANDOFF.mdの運用**: 定期的に蒸留する。確定した内容はCONCEPT/ROADMAP/FEATUREへ吸収し、HANDOFF.md自身は直近セッションの申し送りだけを残す薄いファイルにする。
- **ROADMAP.md / FEATURE.mdを新規作成**した。
- **credential境界の原則をCONCEPT.mdに復帰**（principle 2として再挿入）。以前のセッションで「meta-harness案（既存ハーネスをラップする構想）が担保方法を再検討させる」という理由でpending扱いにしていたが、今回のgrillでmeta-harness案は不採用と確認できたため。どのAgent SDK（Claude Agent SDK / Codex SDK）を使うかは別軸の未決事項としてROADMAP.mdの未解決論点に記録した。
- 分割基準: FEATURE.md=スコープに含むもの/やらないこと（意図的な非スコープ）の境界のみ、ROADMAP.md=全体アーキテクチャ方向性・技術スタック・次の優先順位・未解決論点。当初FEATURE.mdに「実装済み/未実装」のステータスも書いたが、それはPR・commit履歴が既に持つ情報の複製（CONCEPT.md原則3違反）だと指摘を受け、除去した。

### 次のセッションへの申し送り

- ROADMAP.mdの「次の優先順位」1番目、**サンドボックス（worktree/docker、lock managerとの一体化）**から再開してよい。
- ROADMAP.mdの未解決論点（特にAgent SDK選定）はまだ未着手。
