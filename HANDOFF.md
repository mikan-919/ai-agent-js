# 対話ハンドオフ

## 次のセッションへの申し送り

- [#29](https://github.com/mikan-919/oriel/issues/29)のJob所有権接続は`apps/serve/src/job-ownership.ts`にin-processの調停として置いてある。リレーのDurable Objectを作る時に調停側だけをそのまま移し、`serve`側は`ConnectionOwnershipRelay`をWebSocket実装へ差し替える。
- heartbeatのclient側停止期限とserver側失効期限は引数のままにしてある。固定版runtimeでの測定と検証専用環境の実動作から決めるまで既定値を入れない。
- 結果不明の投稿は「読み直し→無ければ一度だけ再送→再度読み直して重複圧縮」で収束する。Issue本文、Linear状態、Git送信、Pull Request作成の収束規則はADR 0005にあるが未実装。
