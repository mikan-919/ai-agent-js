# 対話ハンドオフ（更新版）

このドキュメントは、AIエージェント開発ハーネス（`har`）の設計を詰めた対話セッションの記録。前回のハンドオフから、複数の重要な設計転換があった。次のセッションはこの内容を前提に再開する。

## 背景（変わらない前提）

GitHub・Linear・CONCEPT.md・ROADMAP.mdを組み合わせて、AIエージェントによる開発を扱うハーネスを設計する。OpenSpecは構成から外す。

元々の問題意識:

- エージェントがPRレビューを待ちながら長時間生存できない
- CONCEPT.md / ROADMAP.mdはGit管理されているため、branchごとに見えている内容が異なり「現在のプロジェクト方針」と「そのcommit時点の方針」が混ざる

この2つへの回答は一貫して変わっていない: **エージェントは待機せず、必要なときに毎回Git・GitHub・Linear・workspace documentsから現在の作業文脈を再構成する。** 専用handoff DBや巨大なconversation historyには依存しない。

## 役割分担（更新）

| 要素 | 責務 |
|---|---|
| CONCEPT.md | プロジェクトの比較的安定した思想・原則 |
| ROADMAP.md | プロジェクトが現在向かっている大きな方向 |
| GitHub Issue | 発見された問題・要求・技術的論点（WHAT） |
| Linear | **解決アプローチが人間によって吟味・合意されたことを示す唯一の情報源**（HOW + 承認）。優先順位管理はLinearの副次的な機能であり、本質ではない。他のどのサービスも代替できない、Linearをこの構成に含める唯一の正当化根拠 |
| Pull Request | 実際の変更・レビュー・CI・非同期の対話境界 |
| Harness (`har`) | 上記を読み、現在の作業文脈を再構成してAgentに与える層。加えて今回、**Agentの実行環境そのもの**という役割が加わった（後述） |

同じ情報を各サービスへ複製しない。各ソースに別の責務を持たせる。branch/PR/Issue/Linearの関連付けも、Harness独自の規約を発明せず、各サービスが既に持つ仕組みをそのまま読む:

- **Linear ⇄ branch/PR**: Linear自身のissue識別子検出（branch名に識別子が含まれていれば自動リンク）
- **GitHub Issue ⇄ PR**: GitHubのclosing issue references（`Fixes #87`等のmagic words、構造化データとして取得可能）
- **GitHub Issue ⇄ Linear Issue**: LinearのGitHub issue attachment機能

## 今回確定した設計

### 1. 2ゲートモデル

Agentワークフローの本質は、「提案 → 人間レビュー → 承認」という同一パターンを、2つの高度で繰り返しているだけ、という認識に至った。

```
高度1（解決アプローチ）: Agent草案 → 人間レビュー → 承認 → Linear: Triage → Todo
高度2（実装）        : Agent実装 → 人間レビュー → 承認 → PR: Open → Merged
```

- GitHub Issueが作られたら、Agentが解決アプローチのたたき台をLinear issue（Triage状態）に自動生成する。人間はゼロから書くのではなく、レビュー・修正するだけ。
- 人間がTriageからTodoへ動かすことで初めて「これを今やる」という承認になり、`har start`の対象になる。
- 実装後のPRレビューも同型: Agentが実装 → 人間がレビュー・承認 → マージ。
- **この2つのループはコード上共通化しない。** 触るAPI（Linear API / GitHub API）もデータ形状も違うため、早すぎる共通化は両方に無理な抽象を強いる。重複が本当に痛くなってから統一する。

### 2. write operationの境界（最重要の決定）

> Agentは何を書いても（提案しても）よい。ただしどちらのゲートも、Agent自身が「通過」を宣言することはできない。

- Agentが自由にやってよいこと: Linear issueのdescriptionを書く/書き直す、branchにcommitする、PRにpushする、コメントする
- Agentが絶対にやってはいけないこと: Linear issueをTriageからTodoへ動かす、PRをapprove/mergeする

この境界を「判定ロジック」ではなく「能力の不在」で担保する方針にした:

- **Agent実行環境には、Linear API key / GitHub tokenを一切渡さない。** 外部サービスへの唯一の経路は`har`（自分のbranchへの`git push`のみ例外で直接可）。
- Gate 2（PR）はGitHub branch protection（self-approve禁止・required reviewers）で技術的に強制できる。
- Gate 1（Linear）には同等の技術的な壁がLinear側に存在しないため、**Harness自身がどちらのゲートも「進める」操作を一切実装しない**という設計にした。人間は常にLinear/GitHubのネイティブUI上で直接承認する。Harnessは常に「読むだけ」で、書くのは提案・下書き・push・PR作成・完了後の後片付けに限られる。
- `har finish`は「マージを実行するコマンド」ではなく、**人間がGitHub上で既にマージした後の後片付け**（ローカルbranch削除、Linear issueをDoneへ同期）。マージ自体はGitHubのauto-merge機能を人間がONにすることで、Harnessを経由せずGitHub自身が実行する。

### 3. `har serve`が中心的インターフェースになる（大きな転換）

当初の構成案:

```
             ┌ CLI
             │
Harness Core ├ MCP
             │
             └ Webhook / Event receiver
```

これは以下に更新された。

- **`har serve`が中心。** Claude Agent SDKを組み込み、Agent loopそのものを直接ホストする。「既存のhosted agent productにMCP経由で接続するだけの薄いcontext provider」に留まらない。
- 理由はUXの好みではない。**Agentのtool registryをHarnessが完全に所有することで、「Agentに生credentialを渡さない」という境界を、運用の規律ではなくコードの構造で保証できる。** 人間が設定を誤って生のGitHub MCPを一緒に繋いでしまう、といった抜け道が構造的に無くなる。
- これにより「Harness Coreが自発的にAgentを起動しない」という不変条件自体は維持される。「人間が起動する場所」の選択肢に「`har serve`の中」が加わった、という整理。
- 最初はagent種別もClaude一本に絞ってよい（Codex/pi対応は後回し）。単一ユーザー利用が前提のスコープなので、認証も凝ったOAuthではなくlocalhost bindや単一tokenで十分。
- サーバは概念的に2種類に分かれる: **公開の関係で外部（GitHub/Linear）からのwebhookを受ける口**と、**実際にHarness Core・credential・Agentセッションを保持するローカル側**。公開側は何もsecretを持たない薄いrelayにする（乗っ取られても盗めるものがない）。ただし後述の理由でv1では未実装。

### 4. 起動主体・自動化の最終形

最終的に「誰が/何がAgentを起動するか」は以下に収束した。

```
人間がhar serveのUIで操作する
  または
har serve自身のpolling loopが変化を検知し、
  policy設定（デフォルトon）に従って自動反応する
```

- GitHub Actionsはagent起動の主要アクターの役割からは外れた。理由: Agentが`har serve`内でホストされる以上、GitHub Actions runner上でagentを動かす経路自体が不要になった。GitHub Actionsは、**リポジトリ自体のtest/build pipeline**（`har status`が結果を読むだけの対象）としての役割のみ残る。「CI」という語をこの2つの意味で混同しないよう注意。
- どのライフサイクル段階（草案生成・実装・後片付け）を無人実行してよいかは、Harness自身がpolicy configを読んで許可判断する。デフォルトはon。

### 5. Webhook vs polling: v1はpollingのみ

- 公開relay + ローカルhar serveへの転送という二層構成は、実装として理には適っている（到達可能性の問題と、credentialを外部公開面に置かないという隔離の両方を解決する）。relayを自作せず、`smee.io`のような既存の仕組みを再利用する想定。
- ただし**v1では丸ごと不要**と判断した。理由: このプロジェクトの出発点は「Agentは待機せず、都度状態を再構成すればいい」であり、`har serve`自身の目覚め方にも同じ原則を適用できる——起動時または一定間隔で「前回見た状態」との差分を検知すれば十分で、ミリ秒単位の反応速度はそもそも要件にない。
- relay構成は、pollingが実際に不便になった時点で後付けする。

### 6. 同時実行の排他制御

- **GitHub のref作成APIが持つatomicなcompare-and-swap性**を排他ロックの実体として使う。`refs/harness-locks/<branch名>` というrefを作成できたものだけがロックを取得する（既に存在すれば失敗する）。
- ロックキーは**PR番号ではなくbranch名**に統一。理由: `start`はPRが存在する前のフェーズであり、branch名なら`start → resume → finish`全フェーズで一貫した排他単位にできる。
- Check Run/labelは人間向けのbest-effort表示にとどめ、正しさには関与させない。**git pushのnon-fast-forward拒否を最終安全網**として保持する——ロック機構が壊れてもbranch自体は壊れない。
- TTL = 1時間。超過時はforceフラグなしで自動的に古いlockを上書きし、事実をログ/PRコメントに残す。stealの最終ステップ（ref再作成）もatomicなので、複数が同時にstealを試みても壊れない。

## アーキテクチャ図（現時点の理解）

```
                        ┌─ 人間の操作 (browser)
  har serve (local)  ───┤
    - WorkContext resolver (Git/GitHub/Linear/workspace docs を読む)
    - policy engine (どの段階を無人実行してよいか)
    - lock manager (refs/harness-locks/<branch>)
    - Claude Agent SDK 組み込み（Agent loopをホスト。tool registryを完全所有）
    - polling loop（起動時/一定間隔で差分検知 → policy次第で自動反応）
                        └─ (将来) 公開relay経由のwebhook受信

  GitHub Actions ─── リポジトリ自体のtest/build pipelineのみ（agent起動アクターではない）
```

CLIの位置付け（`har status`等）は要検討（下記「開いている論点」参照）。

## まだ開いている論点

1. **ROADMAP.mdのどの変更を「現在の作業に関連あり」と判定するか。** merge-base時点・main HEAD・branch HEADの3点を区別する方針は変わらないが、drift検出の具体的なアルゴリズムは未設計。
2. **Agentへdiffを生で渡すか、Harnessが意味的に要約するか。**
3. **`har resume`／`har serve`内のAgentセッションが最終的にどんな情報を渡されるか。** WorkContextのどの部分をどう整形するかが未確定。2ゲートモデルにより、Linear issueのdescription/comments（吟味された解決アプローチそのもの）が、GitHub Issueの生テキストより優先度の高い入力になるはず、という示唆はあるが未確定。
4. **実装の入り口はどこか。** 当初は「`har status`をCLIとして実装可能な仕様まで落とす」が次の一手だったが、`har serve`が中心的インターフェースになったことで、先に着手すべきはWorkContext resolver + `har serve`の閲覧・Agentセッション機能であり、CLIはその薄いラッパーとして後回しにすべきか——この問いは投げたが、まだ回答を得ていない。
5. **Gate 1のLinear側権限モデルの検証。** Linearが「特定の状態遷移だけを人間限定にする」権限粒度を提供しているかは未調査（現状は「Agentに credential を渡さない」ことで代替的に解決しているため、必須ではないが、確認できればより強い保証になる）。

## 次にやること（このセクションは以下の継続セッションで更新された）

次のセッションは、上記の開いている論点のどれかを詰めるところから再開する。特に**論点4（実装の入り口）**は、他の論点より先に決めるべき——ここが決まらないと、次に書くべきコードが定まらない。

---

## 継続セッション（2026-08-09）: grillで確定した内容

前回のハンドオフの「まだ開いている論点」5点を、ユーザーへのインタビュー形式（grill）で一つずつ潰した。結果は以下。上のセクションは前回時点の記録として残し、ここに更新分を追記する。

### 実装スタック（新規確定・前回未記載）

- 言語/ランタイム: **TypeScript + Bun + Hono**
- 認証情報: resolverはGitHub token / Linear API keyを**環境変数（`.env`）**から読む（v1はこれで十分。複数リポジトリ横断や`har serve`常駐化が必要になったら`~/.har/config`等へ移行）。

### 論点4（実装の入り口）→ 確定

- **WorkContext resolver + `har serve`を先に作る。CLIは後回し**という方針で確定。
- resolverは**4ソース（Git / GitHub / Linear / workspace docs）を最初から統合**する（1〜2ソースずつ段階的に、ではなく最初からフル）。
- resolverは sandbox（下記）の概念に依存しない。**作業ディレクトリのpathを引数として受け取るだけ**の関数として実装し、疎結合を保つ。
- Claude Agent SDKの組み込みは**後回し**。最初のマイルストーンはSDK無しで「WorkContextが正しく組み立てられるか」を検証すること。
- `har serve`（Honoサーバ）の最初の可観測な挙動は、**WorkContext JSONを返すAPIエンドポイントのみ**（UIは無し）。エンドポイントは**起動時cwdの現在branch固定**（v1ではrepo/branchをリクエストごとに切り替える機能は無し）。

### 新規スコープ: サンドボックス（前回HANDOFF未記載だった要素）

`har`はAgentの実行環境として**サンドボックス**（git worktree または Docker、セッション単位で選択可能）を備える設計であることが今回判明した。

- 粒度: **1 branch(=1作業) = 1サンドボックス**。`resume`時も同じサンドボックスを再利用する（`start → resume → finish`を通じて同一の実行環境が保たれる）。
- worktree/dockerの選択は**セッション（work item）単位**で設定できる。
- **ロックマネージャ（`refs/harness-locks/<branch>`）とサンドボックス作成は一体化**する: サンドボックス作成時にロックを取得する。「作業占有権」と「実行環境」が同じ実体になる。
- このサンドボックス機構自体は**v1のresolver実装のスコープ外**（resolverはpathを受け取るだけなので、sandboxがworktreeを掘ろうがdockerを立てようが関知しない）。具体的な作成・切り替えI/Fは次回以降に持ち越し。

### 論点1（ROADMAP.md drift検出）→ v1スコープ確定

v1では**branch HEADとmain HEADの単純diffのみ**を実装する。merge-base基準での3点区別（前回ハンドオフの本来の方針）は後回し。

### 論点2（diffを生で渡すか要約するか）→ v1の範囲だけ確定

v1のWorkContextでは、diffは**ファイル一覧+統計（+N/-M）のみ**を含み、**本文（生diffテキスト）は含めない**。意味的要約（LLM呼び出しを伴う）はAgent SDK統合後にあらためて検討する。論点自体は完全解決ではなく、v1スコープを切っただけ。

### 論点3（WorkContextの最終形）→ v1のトップレベル構造を確定

**ソースごとに構造化されたJSON**（`git` / `github` / `linear` / `docs` などのキーを持つオブジェクト）とする。単一markdown文字列への統合は不採用。フィールドレベルの詳細スキーマ（各キーの中身）は未確定——実装しながら詰める（プロトタイピング）。

### 論点5（Linear側のGate1権限モデル）→ 調査完了

Linear API/権限モデルを調査した結果:

- Linearには特定のワークフロー状態遷移（例: Triage→Todo）だけを人間限定にする権限粒度は**存在しない**。ロール（Workspace Owner / Admin / Team Owner / Member / Guest）はワークスペース/チーム単位の粗い粒度で、チームレベルでは「誰がworkflow statusesを管理できるか」等のカテゴリ単位の制御はあるが、個別の状態遷移を制限する機能はない。
- OAuth scopeも`read`/`write`/`admin`に加え`issues:create`のようなリソース単位の粒度はあるが、「stateフィールドの変更だけを禁止する」ようなフィールド単位のscopeは存在しない。
- **結論:** 「Agentに credential を一切渡さない」という既存方針が、Gate 1を技術的に担保する**唯一の**手段であることが確定した（Linear側に代替の技術的防御手段は無い）。

参考: [Members and roles – Linear Docs](https://linear.app/docs/members-roles), [OAuth 2.0 authentication – Linear Developers](https://linear.app/developers/oauth-2-0-authentication)

## 次のセッションへの申し送り（更新版）

実装の入り口が確定したので、次のセッションは**コードを書き始めてよい**。最初のPRの具体的スコープ:

1. TypeScript + Bunプロジェクトの初期化（Hono導入）
2. WorkContext resolver: `resolveWorkContext(repoPath: string): Promise<WorkContext>` のような、pathのみを引数に取る関数。Git（現在branch、branch HEAD vs main HEADの単純diff統計）・GitHub（Issue/PR、`.env`のtoken）・Linear（issue、`.env`のkey）・workspace docs（CONCEPT.md/ROADMAP.mdの内容）の4ソースを読み、ソース別キーを持つJSONを組み立てる。
3. `har serve`: Honoサーバに、起動時cwdの現在branchに対する`resolveWorkContext`の結果をJSONで返す単一エンドポイントを実装する。

まだ決まっていない/次回以降に持ち越す論点:

- WorkContextの各ソースキーの詳細フィールドスキーマ（実装しながら決める）
- サンドボックス（worktree/docker）の具体的な作成・切り替えI/F、およびそれとlock managerの一体化実装
- diffの意味的要約ロジック（Agent SDK統合後）
- Claude Agent SDKの組み込み方法そのもの
