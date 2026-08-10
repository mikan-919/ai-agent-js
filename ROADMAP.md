# ROADMAP

今nookがどこに向かっているか。優先順位・次のマイルストーン。頻繁に変わってよい。「今何をして・何をしないか」の詳細スコープはFEATURE.md、変わらない思想はCONCEPT.mdを参照。

## 全体アーキテクチャの方向性

- **`nook serve`が中心的インターフェース。** CLI（`nook status`等）はその薄いラッパーとして後回しにする。ただし「薄いラッパー」とは同じロジックを再利用するという意味であり、HTTP経由で起動中の`nook serve`プロセスに問い合わせる、という意味ではない。`resolveWorkContext`等のresolverはサーバ側状態を一切持たない（原則1）ため、CLIはresolverを直接呼び出し、`nook serve`が起動している前提を置かない。
- **Agent loopをHarnessが直接ホストする。** 「既存のhosted agent productにMCP経由で接続するだけの薄いcontext provider」には留まらない。理由はUXの好みではなく、Agentのtool registryをHarnessが完全に所有することで、「Agentに生credentialを渡さない」という境界（CONCEPT.md原則2）をコードの構造で保証できるため。har（旧名）が既存ハーネス（Claude Code等）をラップする「meta-harness」案は検討の上、不採用と確認済み。
- **サーバは概念的に2種類**: 外部（GitHub/Linear）からのwebhookを受ける公開relay（secretを持たない薄い口、v1では未実装）と、Harness Core・credential・Agentセッションを保持するローカル側。
- **v1はpollingのみ。** 起動時/一定間隔で「前回見た状態」との差分を検知すれば十分とし、webhook relayはpollingが実際に不便になった時点で後付けする。
- **GitHub Actionsはagent起動アクターではない。** Agentが`nook serve`内でホストされる以上、GitHub Actions runner上でagentを動かす経路は不要。GitHub Actionsは、リポジトリ自体のtest/build pipeline（`nook status`が結果を読むだけの対象）としての役割のみ。「CI」という語をこの2つの意味で混同しないこと。
- **サンドボックス**: 1 branch(=1作業) = 1サンドボックス（git worktree / Docker、セッション単位で選択可）。`resume`時も同じサンドボックスを再利用する。ロックマネージャ（`refs/harness-locks/<branch>`）とサンドボックス作成は一体化し、サンドボックス作成時にロックを取得する。

## 技術スタック

- 言語/ランタイム: TypeScript + Bun + Hono
- 認証情報: resolverはGitHub token / Linear API keyを環境変数（`.env`）から読む（v1はこれで十分。複数リポジトリ横断や`nook serve`常駐化が必要になったら`~/.nook/config`等へ移行）

## 次の優先順位

1. Agent SDK統合

## 未解決の論点

1. **Agent SDK選定**: Claude Agent SDK か Codex SDK か未定。
2. **ROADMAP.md/CONCEPT.mdのdrift検出アルゴリズム**: merge-base時点・main HEAD・branch HEADの3点を区別する方針は変わらないが、具体アルゴリズムは未設計（v1はFEATURE.md記載の通り単純diffのみ）。
3. **Agentへdiffを生で渡すか、Harnessが意味的に要約するか**: v1スコープ（ファイル一覧+統計のみ）は確定したが、論点自体はAgent SDK統合後に改めて検討する。
4. **WorkContextの各ソースキーの詳細フィールドスキーマ**: トップレベルは`git`/`github`/`linear`/`docs`のソース別JSONで確定したが、フィールドレベルは実装しながら詰める。
5. **`resolveGithubContext` / `resolveLinearContext` / lock managerの実GitHub API相手の実地検証**: このセッション環境の`GITHUB_TOKEN`はAPI直叩きに403を返す制約があり未検証。ユーザー自身の環境（本物のPATが使える場所）で一度確認するとよい。
6. **Dockerサンドボックスのデフォルトimage（`oven/bun:1`）は未検証**: テストでは軽量な`alpine/git`で動作確認したのみで、実運用でエージェント実行に足りるかは未確認。
