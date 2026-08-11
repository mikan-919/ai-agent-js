# CONCEPT

## この実行ハーネスは何か

この実行ハーネスは、GitHubとLinearを制御面として、複数のローカル環境で開発Agentを動かす分散実行ハーネスである。

仕事の入口・承認・状態・成果は外部サービスに置き、コード編集・build・test・Agent実行はローカルで行う。クラウド上でコードを実行するサービスではない。体験は外部から進捗と成果が見えるクラウド型Agentに近づけつつ、実行環境、ソースコード、詳細な会話履歴、credentialは利用者のローカル側に置く。

## 仕事の正本

一つのJobは次の三つを横断して進む。

- **GitHub Issue — WHAT**: 何を解決するか。Jobの恒久的な識別子。
- **Linear issue — HOW＋実行承認**: どう解決するか。人間がTriageからTodoへ移すことで実行を承認する。
- **GitHub Pull Request — DO＋最終承認**: 実際に何を変更したか。人間がmergeすることで採用を承認する。

Web UIの会話やローカルtranscriptはJobの正本ではない。別のローカル実行環境が会話履歴なしでも実行できる内容まで、WHATとHOWへ確定してからJobにする。

## 目標

人間は、通常の実装ループでは二つの承認ゲートだけを判断する。

1. Linear: Triage → Todo
2. GitHub: Pull Request → Merged

それ以外の、外部状態の観測、作業文脈の再構成、Jobの取得、ローカル実行、進捗反映、レビュー後の再開は実行ハーネスが担う。

## 不変の原則

### 1. チームが判断する状態をローカルだけに閉じない

WHAT、HOW、承認状態、実行状態、成果、レビュー結果はGitHubまたはLinearから確認できなければならない。sandbox、process、cache、transcriptなどのローカル運転状態はローカルに置いてよいが、それらを失っただけでJobそのものが行方不明になってはならない。

一つのローカル実行環境が失われても、GitHub、Linear、Git上のcheckpointから別の実行環境が仕事を再開できることを設計条件とする。

### 2. 承認ゲートは能力の不在で守る

Agent sandboxへGitHub・Linear credentialを渡さない。credentialを保持するのは、人間が登録時に信頼したローカル`serve`プロセスである。GitHub・Linearへの書き込みは`serve`が提供する制限された操作だけを通す。

AgentはTriage上でHOWを提案・修正できるが、TriageからTodoへ移せない。Agentはbranch、commit、PRを提案できるが、PRをmergeできない。

承認後の機械的な状態反映として、実行ハーネスはTodoからIn Progress、PR merge後のDone、およびWHAT/HOW変更時のTriageへの差し戻しを行ってよい。

### 3. 情報源は一つの役割だけを持つ

GitHub IssueはWHAT、LinearはHOWと実行承認、Pull RequestはDOと最終承認を持つ。同じ判断内容をローカルDBや会話履歴へ正本として複製しない。

共有ROADMAP文書をJobの入力にはしない。各人が何を作りたいかはGitHub Issueとして表し、方向と優先順位はGitHub IssueとLinearのviewとして見る。

### 4. 外部イベントは通知であり、現在状態が正本である

GitHub・Linear webhookはローカル`serve`を早く起こすための通知である。通知を失っても、`serve`はGitHub・Linear・Gitの現在状態を読み直して同じ判断を再構成できなければならない。公開relayはJob DBやAgent sessionを正本として持たない。

### 5. 分散実行では所有権を外部操作の直前に確認する

JobはGitHub Issue単位の期限付きleaseとbranch単位のlockを取得した一つの`serve`だけが実行する。push、PR操作、Issueコメント、Linear更新などの外部操作の直前に、`serve`は有効なleaseをまだ所有していることを確認する。leaseを失った古い実行は外部状態を書き換えられない。

## プロジェクト文脈

CONCEPT.mdは、なぜ作るか、何をするか、何をしないかをAgentへ渡す推奨文書である。存在する場合は作業branch版を読み、default branchとの差分を人間とAgentの両方へ提示する。差分があることだけを理由に実行は止めない。

CONCEPT.mdがないrepositoryでは、AGENTS.mdなど通常のコーディングAgentが読むinstructionsを使う。専用manifestの導入を必須にはしない。

## ローカル実行とクラウドrelayの境界

ローカル`serve`はrepository単位で起動し、Agent、sandbox、transcript、GitHubの短命token、Linear tokenを保持する。Web UIも同じ`serve`がlocalhostで提供する。

公開relayはGitHub App・Linear webhookの公開口、OAuth callback、短命GitHub tokenの発行、接続中`serve`への通知と検索要求の中継だけを担う。コード、Job DB、Agent session、transcriptは保存しない。

初期のrelayは独自アカウントを要求せず、GitHub App installationとGitHubログインを利用単位とする。

## ローカル履歴

transcriptは各`serve`がローカルに保存し、自動削除しない。人間がWeb UIから明示した場合だけ削除する。

Agentは必要に応じて、自分の`serve`と、relayへ接続中の同一repositoryを担当する他の`serve`へ履歴検索を依頼できる。検索範囲はlocal、current Job、repositoryとし、relayは問い合わせを中継するだけで内容を保存しない。

## checkpointと引き継ぎ

Agentは安定した区切りでcheckpoint commitをpushする。checkpointには、その地点から別の実行環境が再開するためのHANDOFF.mdを含める。HANDOFF.mdは追記ログではなく、現在地、確定した判断、未解決点、次の一手だけを持つ。

HANDOFF.mdはPRをreadyにする前に削除し、最終差分には含めない。途中のcommit履歴に残ることは許容する。
