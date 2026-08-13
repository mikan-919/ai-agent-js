# 対話ハンドオフ

## 次のセッションへの申し送り

- [ADR 0003](./docs/adr/0003-approval-admission-and-reconciliation.md)で、Todo承認後・worker開始前のapproval fingerprint、canonical branchのCAS seal、既存branch/resume、fingerprintを使うoperation fencingをAcceptedにした。fingerprintはversion bindingであり、本文の正本ではない。
- fresh Triage→Todoはapproval episode keyでnew Jobになる。同fingerprintの既存branch adoptionには安全なcheckpoint/known-write証明が必要で、そのtakeover/reconciliation詳細は[ROADMAP.md](./ROADMAP.md)で未解決としている。
- 次は、登録済みcredentialで[repositoryごとのhistory capability / contract gate](./docs/research/approval-history-capabilities.md)を検証する。Todo承認からsealまでのcross-provider順序、attachment relink、Linear historyのgrouping/omissionを証明できなければautomatic admissionを実装・有効化せず、人間の再承認を待つ。
- Triageへの機械的な差し戻し、PR/Git push、lease ref、device/OAuth、Todo以後のstate更新、外部writeごとのreconciliationは未解決である。
