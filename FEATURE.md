# FEATURE

nookが「何を対象にして・何を対象にしないか」というスコープの境界。**進捗（実装済みかどうか）はここに書かない** — それはPR・commit履歴が既に持っている情報であり、CONCEPT.md原則3（情報源を複製しない）によりここへ複製しない。「今どこまで進んでいるか」を知りたければGitHub上のPR/commitを見る。

## スコープに含むもの

- **WorkContext resolver**: Git・GitHub・Linear・workspace docsの4ソースを統合し、作業文脈を再構成する。sandbox概念に依存せず、pathのみを引数に取る。
- **`nook serve`**: Agent loopをホストし、tool registryを完全所有するローカルサーバ。
- **lock manager**: `refs/harness-locks/<branch>`によるbranch単位の排他制御。
- **sandbox**: git worktree / Dockerによる、1 branch = 1 sandboxの実行環境。lock managerと一体化する。
- **CLI**: `nook serve`の薄いラッパー。
- **Agent SDK統合**: piの`Agent`（`pi-agent-core`）を`nook serve`内にホストする。`POST /agent/run`が起点——branchのsandboxをcreate/resumeし、そのsandbox内で`resolveWorkContext`を呼んでsystem promptを組み立て（CONCEPT/ROADMAP/FEATURE/HANDOFFの4文書＋git diff＋GitHub/Linear状態）、agentに1つのpromptを渡して完了まで待つ。agentに渡すtoolはv1では最小集合: `read_file`/`write_file`/`edit_file`/`bash`（すべてsandbox rootにスコープ）と`create_pull_request`（push＋PR作成/更新のみを担い、commitはagent自身がbash経由の`git commit`で行う）。`create_pull_request`はnook側でGITHUB_TOKENを使って実行し、token自体はagentに渡さない（CONCEPT.md原則2）。agentが無応答になった場合はアイドルタイムアウトで中断し、実行中はagentの進捗をbranch lockのハートビートとしても使う（詳細はROADMAP.md）。sandboxをresumeした場合、直前のagent会話transcript（機械的圧縮＋LLM要約で圧縮したもの）をsystem promptの追加セクションとして注入する（詳細はROADMAP.md）。

各要素の優先順位・着手順はROADMAP.mdを参照。

## やらないこと（意図的な非スコープ）

- **Agentによる承認ゲート操作**: Linear issueをTriage→Todoへ動かす操作、PRをapprove/mergeする操作は実装しない。Harnessは常に「読むだけ」で、書けるのは提案・下書き・push・PR作成・完了後の後片付けまで（CONCEPT.md原則2）。
- **2ゲートループの共通化**: 解決アプローチループ（Linear）と実装ループ（GitHub PR）はコード上統一しない。触るAPI・データ形状が違うため、早すぎる抽象化を避ける。重複が本当に痛くなってから統一する。
- **複数エージェント種別対応**: v1はエージェント種別を1つに絞る（Codex/pi等の複数バックエンド対応は後回し）。
- **凝ったOAuth認証**: 単一ユーザー利用が前提のスコープなので、localhost bindや単一tokenで十分とし、OAuthは実装しない。
- **webhook relay**: 公開relay + ローカル`nook serve`への転送という二層構成はv1では実装しない。起動時/一定間隔のpollingで差分検知する。relayが実際に不便になった時点で後付けする。
- **ROADMAP driftのmerge-base基準3点区別**: branch HEAD と main HEAD の単純diffのみを対象にする。merge-base基準の3点区別は対象外。
- **diffの意味的要約**: WorkContextはdiffをファイル一覧+統計（+N/-M）のみ対象にし、本文（生diffテキスト）もLLMによる要約も対象にしない。
