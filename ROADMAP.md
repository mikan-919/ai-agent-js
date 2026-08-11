# ROADMAP

この文書は、分散実行モデルのアーキテクチャを固めるまで、設計方向と未解決事項を保持する。共有ROADMAPを恒久的なJob入力にはしない。実装を始める前に未解決事項をGitHub Issueへ分解し、以後の優先順位はGitHub IssueとLinearのviewで管理する。

## 移行するアーキテクチャ

```text
GitHub Issue (WHAT / Job ID)
        │
        ▼
Linear issue (HOW / Triage→Todo approval)
        │ webhook
        ▼
public relay
        │ notification / short-lived token
        ▼
repository-scoped local serve instances
        │ Job lease + branch lock
        ▼
local Agent / sandbox
        │ checkpoint / push / PR
        ▼
GitHub Pull Request (DO / merge approval)
```

### 公開relay

- GitHub App webhookとLinear webhookを受ける。
- GitHub App秘密鍵を保持し、repositoryと権限を絞った短命installation tokenを発行する。
- Linear OAuth＋PKCEのcallbackをローカル`serve`へ中継する。
- 接続中`serve`への状態変更通知とtranscript検索要求を中継する。
- Job DB、scheduler、コード、transcript、Agent sessionは保存しない。
- 初期は独自アカウントを持たず、GitHub App installationを利用単位とする。

### ローカル`serve`

- 一つのrepositoryを担当する。
- 初回にブラウザで人間が登録・承認する。
- GitHub短命tokenとLinear OAuth tokenをOSのcredential storeへ保存する。
- Web UIをlocalhostで提供する。
- Agent sandboxへcredentialを渡さず、外部操作を専用toolとして提供する。
- webhookを逃した場合はGitHub・Linearの現在状態を読み直す。

### Jobの発見と取得

- GitHub Issue URLをLinear attachment APIへ渡し、対応するLinear issueを逆引きする。
- 対応するLinear issueが一つだけでTodoの場合に実行候補とする。
- GitHub Issue単位のremote Git ref leaseを取得する。
- Linear issueが示すbranch名に対するbranch lockを取得する。
- どちらかを取得できなければ実行しない。
- 一つのJobにつきactiveなbranchとPRは一つにする。

### Jobの状態遷移

- claim成功時にLinearをTodoからIn Progressへ更新する。
- WHATまたはHOWが承認後に変わったら実行を止め、leaseを解放し、LinearをTriageへ戻す。
- PRが未mergeでcloseされた場合も自動再試行せず、Linearの再承認を待つ。
- PR merge後にLinearをDoneへ更新し、復元可能でcleanなsandboxを削除する。
- PRレビュー対応は前回workerを優先し、利用できない場合は別workerが引き継ぐ。

### checkpointと履歴

- Agentは安定点でcheckpoint commitとHANDOFF.mdをpushする。
- PRをreadyにする前にHANDOFF.mdを削除する。
- transcriptはsandboxと分離してローカルに保存し、自動削除しない。
- local、current Job、repositoryの範囲で、接続中`serve`間の検索を可能にする。

### 実行環境

- Nixを必須にせず、repositoryが持つNix、Docker、Dev Container、local worktree等の環境定義を利用する。
- host OSと、Jobへ提供する実行環境を区別する。Windows上のWSLはLinux実行環境として扱う。
- capabilityのschemaと設定値はYAMLで記述する。
- v1ではOS、architecture、利用可能なsandbox方式など自動検査できる項目だけを扱う。
- 自動検査できない汎用能力指定は、実例が出るまで設計しない。

## 文書構成

- 「する／しない」はCONCEPT.mdを正本とし、FEATURE.mdはその配置を示すためだけに残す。
- ROADMAP.mdは設計中の論点に限って使い、実装タスクはGitHub IssueとLinearへ移す。
- HANDOFF.mdは現在の設計セッションから再開するための情報だけを持つ。

## 実装前に決めること

- Job lease refの形式、期限、heartbeat、引き継ぎ手順
- relayと`serve`間の接続方式と検索要求の認可
- relayのhosting先、installation単位の利用制限、worker登録解除
- GitHub／Linear OAuthとOS credential storeの実装
- WHAT／HOW変更検知に使う版の記録方法
- YAML schemaの詳細とruntime validation
- sandbox backendの検出順序
- draft PRを作る時点とcheckpoint頻度を調整するAgent prompt
- Job、worker、serve、relay、lease、lockの責務と状態モデル
- relay、serve、Agent sandbox間の通信境界とtool API
- 障害、再接続、二重実行、途中再開を含むreconciliation手順
- 最小構成で端から端まで成立させる最初のtracer bullet

## 設計を固める順序

1. コンポーネントの責務と信頼境界を図とinterfaceで定義する。
2. Jobの状態遷移、lease、branch lockの不変条件を定義する。
3. GitHub・Linear・relay・serve間のイベントとreconciliationを時系列で定義する。
4. credential、認証、認可、token受け渡しを脅威モデルとともに定義する。
5. checkpoint、transcript、worker引き継ぎの保存・検索境界を定義する。
6. capability schemaと実行環境選択を定義する。
7. 決定事項をGitHub Issueへ分解し、最初のtracer bulletを承認してから実装を開始する。
