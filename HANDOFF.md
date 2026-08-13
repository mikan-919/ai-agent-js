# 対話ハンドオフ

## 次のセッションへの申し送り

- [ADR 0003](./docs/adr/0003-approval-admission-and-reconciliation.md)で、Todo承認後・worker開始前のapproval fingerprint、canonical branchのCAS seal、既存branch/resume、fingerprintを使うoperation fencingをAcceptedにした。fingerprintはversion bindingであり、本文の正本ではない。
- fresh Triage→Todoでfingerprintが同じなら同じ論理Jobを新しいlease generationで再開し、同じbranchをadoptするには安全なcheckpoint/known-write証明を要求する。そのtakeover/reconciliation詳細は[ROADMAP.md](./ROADMAP.md)で未解決としている。
- native historyの完全性はautomatic admissionの条件にしない。Todo後の現在値を所有権取得の前後で二度読み、state、attachment、WHAT/HOW、fingerprint、baseが一致すればworkerを開始する。二回のread間で変更後に元へ戻った事実は検出しない。
- 観測した承認対象の不一致ではworkerと外部操作を停止し、current leaseと対象Workflowを確認した`serve`がTodoをTriageへ戻す。relayは通知とroutingに限定する。
- 次は、Todo→Triage差し戻しwriteのidempotency、条件付き更新、結果不明時のreconciliationを定義する。専用fixtureを使う現在値の二重readと、GitHub App installation tokenによるatomic `updateRefs`のcontract testも実装前に必要である。
- PR/Git push、lease ref、device/OAuth、Todo以後のstate更新、その他の外部writeごとのreconciliationは未解決である。
