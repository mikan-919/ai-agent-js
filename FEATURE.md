# FEATURE

ハーネスが「何を対象にして・何を対象にしないか」というスコープの境界。**進捗（実装済みかどうか）はここに書かない** — それはPR・commit履歴が既に持っている情報であり、CONCEPT.md原則3（情報源を複製しない）によりここへ複製しない。「今どこまで進んでいるか」を知りたければGitHub上のPR/commitを見る。

## スコープに含むもの

- **WorkContext resolver**: Git・GitHub・Linear・workspace docsの4ソースを統合し、作業文脈を再構成する。sandbox概念に依存せず、pathのみを引数に取る。
- **`serve`サブコマンド**: Agent loopをホストし、tool registryを完全所有するローカルサーバ。
- **lock manager**: `refs/harness-locks/<branch>`によるbranch単位の排他制御。
- **sandbox**: git worktree / Dockerによる、1 branch = 1 sandboxの実行環境。lock managerと一体化する。
- **CLI**: `serve`サブコマンドの薄いラッパー。
- **Agent SDK統合**: piの`Agent`（`pi-agent-core`）を`serve`サブコマンド内にホストする。`POST /agent/run`が起点——branchのsandboxをcreate/resumeし、そのsandbox内で`resolveWorkContext`を呼んでsystem promptを組み立て（CONCEPT/ROADMAP/FEATURE/HANDOFFの4文書＋git diff＋GitHub/Linear状態）、agentに1つのpromptを渡して完了まで待つ。agentに渡すtoolはv1では最小集合: `read_file`/`write_file`/`edit_file`/`bash`（すべてsandbox rootにスコープ）と`create_pull_request`（push＋PR作成/更新のみを担い、commitはagent自身がbash経由の`git commit`で行う）。`create_pull_request`はハーネス側でGITHUB_TOKENを使って実行し、token自体はagentに渡さない（CONCEPT.md原則2）。agentが無応答になった場合はアイドルタイムアウトで中断し、実行中はagentの進捗をbranch lockのハートビートとしても使う（詳細はROADMAP.md）。sandboxをresumeした場合、直前のagent会話transcript（機械的圧縮＋LLM要約で圧縮したもの）をsystem promptの追加セクションとして注入する（詳細はROADMAP.md）。
- **web UI**: `serve`サブコマンドに統合された、人間向けの主要インターフェース（別プロセス・別ポートは持たない）。branch単位でwork context（git diff／GitHub PR・linked issues／Linear issue／docs drift）を閲覧し（`GET /work-context/:branch`）、agentとchat形式で対話する（`POST /agent/run/stream` — 既存`POST /agent/run`と同じ`runAgent`をSSEで包んだもの。turnごとの進捗をそのまま届ける）。承認ゲート（PR merge、Linear Triage→Todo）はstate表示とGitHub/Linearへの外部リンクのみを提供し、UIから直接操作する手段は持たない。フロントエンドはReact + Tailwind CSS v4 + shadcn/ui、`serve`サブコマンドが`dist/web`を静的配信する（詳細はROADMAP.md）。

- **agent session**: 1回のsandbox作成に対して複数ターンの対話を送り続けられる`createSession`/`AgentSession`（`src/agent/session.ts`）。一発実行の`runAgent`（`POST /agent/run`が使う）とweb UIのchat（`POST /agent/run/stream`、branchごとに`serve`サブコマンドのメモリ上でsessionを保持）の両方がこの上に乗る共通基盤（詳細はROADMAP.md）。
- **docsエージェント（`docs`サブコマンド [branch指定可]）**: CONCEPT.md/ROADMAP.md/FEATURE.md/HANDOFF.mdの4ファイルに対象を絞った、ローカル対話用のエージェント。実装エージェントと同じsandbox/lockの実行モデルを使うが、branchは新規作成せず呼び出し時点のbranchをそのまま使う。tool registryは4ファイルへのread/write/edit・`git_commit`（staging対象も同じ4ファイルに限定）・`git_push`（main/default branchへの直pushのみ拒否）に絞り、`bash`と`create_pull_request`は持たない（詳細はROADMAP.md）。
- **ticket切り出しagent（`ticket`サブコマンド）**: ROADMAP.mdの「未解決の論点」「次の優先順位」とHANDOFF.mdの「次のセッションへの申し送り」——人間がすでに自覚している未着手事項——を読み、GitHub Issueとして切り出す。読み取り対象はこの2ファイルの該当セクションと、重複起票防止のための既存open GitHub Issue一覧に限定し、CONCEPT.md/FEATURE.mdの全文やソースコードは読まない（実装状況の自己判定はしない）。切り出したIssueは提案ラベル付きで直接作成し（1回の実行での作成数に上限あり）、実装エージェント・docsエージェントと同じsandbox/lockの実行モデルを使うが対象branchは常にdefault branchに固定する。tool registryはread（対象ドキュメント＋Issue一覧）+`create_issue`のみで、write/edit/bash/git_commit/git_push/create_pull_requestは持たない。起動トリガーは手動実行とpolling実行の両方に対応する。提案ラベル付きIssueへの人間のコメントに対しては、同agentが`reply_to_issue`ツール（コメント返信のみ、Issue本文・タイトルは編集しない）で会話を継続できる（詳細はROADMAP.md）。

各要素の優先順位・着手順はROADMAP.mdを参照。

## やらないこと（意図的な非スコープ）

- **Agentによる承認ゲート操作**: Linear issueをTriage→Todoへ動かす操作、PRをapprove/mergeする操作は実装しない。ハーネスは常に「読むだけ」で、書けるのは提案・下書き・push・PR作成・完了後の後片付けまで（CONCEPT.md原則2）。web UIも同様——PR/Linearの状態表示と外部リンクの提示に留め、merge/approveボタンのような操作手段は置かない。
- **web UIでのSSE再接続・実行中run表示の永続化**: ページのリロードやブラウザの切断で進行中のchat runの表示は失われる（`runAgent`自体はサーバ側で最後まで実行され、transcriptは保存される——失われるのはブラウザ側の表示だけ）。streamを再接続して進捗表示を復元する仕組みはv1では持たない。
- **2ゲートループの共通化**: 解決アプローチループ（Linear）と実装ループ（GitHub PR）はコード上統一しない。触るAPI・データ形状が違うため、早すぎる抽象化を避ける。重複が本当に痛くなってから統一する。
- **複数エージェント種別対応**: v1はエージェント種別を1つに絞る（Codex/pi等の複数バックエンド対応は後回し）。
- **凝ったOAuth認証**: 単一ユーザー利用が前提のスコープなので、localhost bindや単一tokenで十分とし、OAuthは実装しない。
- **webhook relay**: 公開relay + ローカル`serve`サブコマンドへの転送という二層構成はv1では実装しない。起動時/一定間隔のpollingで差分検知する。relayが実際に不便になった時点で後付けする。
- **ROADMAP driftのmerge-base基準3点区別**: branch HEAD と main HEAD の単純diffのみを対象にする。merge-base基準の3点区別は対象外。
- **diffの意味的要約**: WorkContextはdiffをファイル一覧+統計（+N/-M）のみ対象にし、本文（生diffテキスト）もLLMによる要約も対象にしない。
- **ticket切り出しagentによる新しい方向性の提案**: ROADMAP.md/HANDOFF.mdに書かれた既知のギャップが尽きていても、agentが自らプロジェクトの新しい方向性を考えて起票することはしない。方向性そのものの検討はCONCEPT.mdの目標に照らした人間の判断が必要な領域であり、既存の`docs`サブコマンド（人間との対話）に委ねる。
- **ticket切り出しagentによるIssue本文・タイトルの編集**: 提案ラベル付きIssue上の会話機能はコメント返信のみに留め、Issue自体の書き換えはしない。合意形成の履歴はコメントスレッドに残し、確定した変更は人間が本文へ反映する。
