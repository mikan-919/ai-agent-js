# 対話ハンドオフ

このドキュメントは直近セッションの「次への申し送り」だけを持つ。確定した思想・原則はCONCEPT.md、方向性・優先順位・未解決論点はROADMAP.md、実装済み/未実装/やらないことのスコープはFEATURE.mdを参照。過去の実装ログの詳細はgit commit履歴を参照（原則1: 状態は外部に置く）。

## 直近セッション（2026-08-10）: Agent SDK統合（pi採用、`POST /agent/run`実装）

ROADMAP.md未解決論点1（Claude Agent SDK vs Codex SDK）はgrill-meで詰めた結果、どちらでもなく**pi**（`@earendil-works/pi-agent-core` + `pi-ai`、OSS・provider非依存）を採用した。判断の経緯や技術的な理由はROADMAP.mdの技術スタック節に記載済み。

- `pi-coding-agent`（インタラクティブCLI向けの`AgentSession`）は使わず、低レベルの`Agent`クラス（`pi-agent-core`）を直接使用。理由: nook自身がsystem prompt/tool registryを完全に組み立てる設計（原則2）と、`AgentSession`が前提とするセッション永続化・拡張機能レイヤーが不要かつ原則1と重複するため。
- `pi-agent-core`にはより高レベルな`AgentHarness`クラスも存在するが、インストールしたバージョン（0.84.1）では全メソッドが`HarnessNotImplemented`を投げるスタブだった。`Agent`クラスは実装済みで動作する。
- `DocsContext`をCONCEPT/ROADMAPの2つからCONCEPT/ROADMAP/FEATURE/HANDOFFの4つに拡張（`src/context/docs.ts`）。system promptはこの4文書全部を埋め込む。
- 実装場所: `src/agent/`（`model.ts`, `systemPrompt.ts`, `sandboxTools.ts`, `pullRequest.ts`, `run.ts`）。エンドポイントは`src/serve.ts`の`POST /agent/run`（body: `{branch, prompt}`、blocking）。

## 次のセッションへの申し送り

- **未検証**: このセッション環境にLLM provider（Anthropic等)のAPI keyが無く、`POST /agent/run`の実地動作（実際にモデルを呼んでtoolを実行し、PRを作るところまで）は一度も確認できていない。ユーザー自身の環境で最初に試すこと。
- ROADMAP.md未解決論点4（`resolveGithubContext`等の実GitHub API相手の実地検証）も同様に未検証のまま。
- 次の設計判断が必要になりそうな点はROADMAP.md「次の優先順位」「未解決の論点」を参照（sandbox resume時のagent会話transcript引き継ぎ、`POST /agent/run`のタイムアウト挙動など）。
