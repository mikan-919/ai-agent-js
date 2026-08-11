# ROADMAP

この文書は、現在の実装を新しい分散実行モデルへ移行する間だけ、移行方向と未解決事項を保持する。共有ROADMAPを恒久的なJob入力にはしない。移行後、作りたいものと優先順位はGitHub IssueとLinearのviewへ移し、この文書は廃止する。

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

## 文書構成の移行

- FEATURE.mdの「する／しない」はCONCEPT.mdへ統合する。
- ROADMAP.mdを恒久的な共有計画としては使わず、GitHub IssueとLinearのviewへ移す。
- HANDOFF.mdは共有計画ではなくcheckpoint再開情報として扱い、PRの最終差分から除く。
- 現行コードが4文書を固定参照している間はファイルを残し、resolver・docs agent・ticket agentの移行と同時に整理する。

## 未解決の実装詳細

- Job lease refの形式、期限、heartbeat、引き継ぎ手順
- relayと`serve`間の接続方式と検索要求の認可
- relayのhosting先、installation単位の利用制限、worker登録解除
- GitHub／Linear OAuthとOS credential storeの実装
- WHAT／HOW変更検知に使う版の記録方法
- YAML schemaの詳細とruntime validation
- sandbox backendの検出順序
- draft PRを作る時点とcheckpoint頻度を調整するAgent prompt
- 現行のbranch中心resolver・session・ticket agentからJob中心reconcilerへの移行順序

## 当面の実装順序

1. GitHub Issue URLからLinear issueを解決し、Job候補を構成する。
2. branch lockと分離したIssue単位のJob leaseを導入する。
3. 外部操作の直前にlease所有を検証する。
4. `serve`をrepository単位workerとして整理し、状態遷移を実装する。
5. GitHub App／Linear webhookを受ける公開relayとworker登録を導入する。
6. credentialをAgent sandboxから完全に分離し、OS credential storeへ移す。
7. checkpoint HANDOFFとrepository内transcript検索を導入する。
8. 4文書前提とticket切り出しagentを新しいIssue中心モデルへ移行する。
