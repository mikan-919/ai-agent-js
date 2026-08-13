# 対話ハンドオフ

## 次のセッションへの申し送り

- [ADR 0005](./docs/adr/0005-connection-liveness-and-external-write-reconciliation.md)で、device bearer tokenによる接続認証、heartbeatによるstale接続の失効、自動再接続、用途別の外部操作、結果不明時の機械的な収束、Linear状態反映、Git送信、Pull Request重複圧縮、checkpoint方針を確定した。
- 結果不明の操作は盲目的に再送しないが、比較条件、現在値、操作ID、重複圧縮で同じ意図へ収束できる場合は`serve`が再読、再送、余分な成果の削除まで行う。意味的競合だけをAgentまたは人間へ戻す。
- 外部操作はharnessへ汎用APIを公開せず、Workflow phaseと対象を固定した用途別操作にする。`serve`は操作をSQLiteへ保存して操作IDを返し、完了結果を後続eventで通知する。
- 次は、承認済み設計をGitHub Issueへ実装単位で分解し、`packages/contracts`、所有権接続、外部操作outboxを通る最初のtracer bulletを選ぶ。message field、heartbeat時間値、資源上限は実装時の測定と検証専用環境での実動作確認から決める。
