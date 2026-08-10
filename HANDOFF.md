# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 直近セッション（2026-08-10）: サンドボックス（Dockerバックエンド）実装

サンドボックスにDockerバックエンドを追加した。`createSandbox` / `destroySandbox`は`backend: "worktree" | "docker"`で選択可能（デフォルトは`worktree`）。lock取得/解放のロジックはbackendに依らず共通化し、`src/sandbox/worktree.ts`（既存ロジックを分離）と`src/sandbox/docker.ts`（新規）にbackend別の実体を持たせた。

- Dockerバックエンドは、ホストのrepoPathをコンテナ内の同一絶対パスへbind mountし、`docker exec`経由で`git worktree add`をコンテナ内で実行する方式。worktreeのメタデータ（`.git/worktrees/<name>`）はホスト側repoに書き込まれるが、実際の作業ファイルはコンテナのdisk layerにしか存在しない。
- 「resumed」判定はworktreeバックエンドと違い、コンテナの存在有無（running/stopped/absent）で行う。stoppedなら`docker start`で再利用、absentなら新規作成+`worktree add`。
- destroy時は`docker rm -f`の後に`git worktree prune`でホスト側のメタデータを掃除する（`worktree remove`はコンテナ削除後にパスをstatできず使えないため）。
- destroyは`force`無しだとコンテナ内`git status --porcelain`で未コミット変更を検知し拒否する（worktreeバックエンドの安全性と揃えた）。
- コンテナ起動時に`--entrypoint tail`で上書きしている。あらゆるimageを「execで触るだけの受け皿」として使うための決定で、image本来のentrypointに依存しない。

## 次のセッションへの申し送り

- ROADMAP.mdの優先順位を更新済み（次は「CLI」→「Agent SDK統合」）。
- ROADMAP.md未解決論点5（`resolveGithubContext` / `resolveLinearContext` / lock managerの実GitHub API相手の実地検証）は依然未検証。
- Dockerバックエンドのデフォルトimageは`oven/bun:1`（未検証 — テストではgit入り軽量imageの`alpine/git`を使って動作確認したのみ）。実運用でこのimageがエージェント実行に足りるかは要確認。
