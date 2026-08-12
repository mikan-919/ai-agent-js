# 対話ハンドオフ

## 次のセッションへの申し送り

- [ADR 0002](./docs/adr/0002-job-ownership-and-execution-state.md)を正本として、GitHub Issueで識別する長期のWorkflow、Workflow内の一回の実行であるJob、Jobを実行する一回のharness process attemptであるworkerを使う。
- 次は[ROADMAP.md](./ROADMAP.md)の設計順序3に従い、GitHub、Linear、relay、`serve`間のeventとreconciliationを時系列で定義する。
- exactなJob identity encoding、providerごとのtrigger/input key対応、WHAT/HOW revision表現、remote lease ref、外部操作ごとのreconciliationは未解決である。
