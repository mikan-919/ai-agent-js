# 対話ハンドオフ

## 次のセッションへの申し送り

- 既存実装を削除し、設計文書だけの状態へ戻した。削除前の実装はgit履歴から復元できる。
- CONCEPT.mdの不変の原則は変更していない。
- v1技術スタックのgrillを完了し、確定事項をROADMAP.md、対象／非対象をFEATURE.mdへ保存した。
- v1の実行backendはworktreeだけであり、`.oriel.yaml`で`execution.backend: worktree`と`execution.autonomous: true`を明示したrepositoryでは自立Jobを許可する。worktreeは強いhost隔離を提供しない。
- Agent loopはharnessの`@earendil-works/pi-agent-core`、model接続は`serve`の`@earendil-works/pi-ai`が担う。採用前に固定版のBun適合試験を通す。
- 実装はまだ再開しない。次はremote ref lease、承認revision、reconciliation、tool APIの未解決事項を狭め、最初のtracer bulletを定義する。
- 設計が固まったらGitHub IssueとLinearへ作業を分解し、最初のtracer bulletを人間が承認してから実装する。
- GitHub repositoryは`mikan-919/oriel`へ改名済みだが、local `origin` URLは旧`mikan-919/sable`のままである。
