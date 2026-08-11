# 対話ハンドオフ

## 次のセッションへの申し送り

- CONCEPT.mdを「GitHub／Linearを制御面とする分散ローカル実行ハーネス」という合意内容へ更新した。
- ROADMAP.mdには、現行実装からJob中心モデルへ移す順序と未解決の実装詳細を保存した。
- FEATURE.mdの役割はCONCEPT.mdへ統合し、現行コードが4文書を固定参照する間だけ互換用に残した。
- 次はROADMAP.mdの「当面の実装順序」1から始める。GitHub Issue URLをLinear attachment APIへ渡して対応issueを一意に解決し、branch作成前のJob候補を構成する。
- 実装時は、ユーザーの既存変更であるCLAUDE.mdと未追跡のAGENTS.mdを変更・commitしない。
