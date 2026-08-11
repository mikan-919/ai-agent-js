# FEATURE

この文書の「する／しない」はCONCEPT.mdへ統合された。workspace documentの配置を明示するために残すが、新しい設計判断はここへ追加しない。

## 実装しないもの

- 共有ROADMAPをJobの正本として扱う機能
- FEATURE.mdを独立した製品判断の正本として扱う機能
- HANDOFF.mdを常設workspace documentとして無条件に読み込む機能

## 移行中も守る境界

- AgentはLinearのTriage→Todoを実行できない。
- AgentはPull Requestをmergeできない。
- Agent sandboxへGitHub・Linear credentialを渡さない。
- WHATはGitHub Issue、HOWと実行承認はLinear、DOと最終承認はPull Requestを正本とする。
- transcriptとWeb UI会話はJobの正本にしない。
