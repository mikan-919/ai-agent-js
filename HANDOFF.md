# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 直近セッション（2026-08-10）: サンドボックス（git worktreeバックエンド）実装

ROADMAP.mdの優先順位1番目、サンドボックスに着手した。`src/sandbox/`を新設し、`createSandbox` / `destroySandbox`を実装した。

- `createSandbox`は、branch用のgit worktree作成とlock managerの`acquireLock`を一体の操作として扱う。ロック無しのサンドボックスは安全でないため。
- 「サンドボックス作成 = ロック取得」の未解決だった実装I/F（旧ROADMAP未解決論点5）を決めた: holder識別子はデフォルト`hostname:pid`（呼び出し側で上書き可）。`acquireLock`自体には「同じholderによる再取得」という概念が無いため、resume判定（同じholderが有効なlockを既に持っているか）は`createSandbox`側の責務にした。resumeの場合は既存worktreeをそのまま再利用する。
- worktreeの配置先は`~/.nook/sandboxes/<owner>-<repo>/<branch>`（デフォルト、`baseDir`で上書き可）。
- `nook serve`に`POST /sandbox` / `DELETE /sandbox/:branch`を追加し、HTTP経由で呼べるようにした。

Dockerバックエンドは未着手。ROADMAP.mdの「次の優先順位」1番目を「サンドボックス: Dockerバックエンド」に更新した。

### 次のセッションへの申し送り

- Dockerバックエンドの実装に進むか、優先順位を入れ替えてCLIへ進むか、セッション開始時に判断する。
- ROADMAP.mdの未解決論点5（実GitHub API相手の実地検証）はまだ未検証のまま。
