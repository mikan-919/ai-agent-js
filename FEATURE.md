# FEATURE

この文書の「する／しない」はCONCEPT.mdへ統合された。現行コードがworkspace documentを4ファイル固定で参照しているため、移行完了までは互換用に残す。新しい設計判断はここへ追加しない。

## 移行後に削除するもの

- 共有ROADMAPからGitHub Issueを切り出すticket agent
- ROADMAP.mdをJob入力として読む処理
- FEATURE.mdを独立した正本として読む処理
- HANDOFF.mdを常設workspace documentとしてsystem promptへ無条件に埋め込む処理

## 移行中も守る境界

- AgentはLinearのTriage→Todoを実行できない。
- AgentはPull Requestをmergeできない。
- Agent sandboxへGitHub・Linear credentialを渡さない。
- WHATはGitHub Issue、HOWと実行承認はLinear、DOと最終承認はPull Requestを正本とする。
- transcriptとWeb UI会話はJobの正本にしない。
