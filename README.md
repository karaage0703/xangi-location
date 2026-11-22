# xangi-location

OwnTracksから本人の最新位置を受信し、xangiが必要なときに参照できる拡張です。位置の取得時刻と精度も返します。

## 主な機能

- 認証付きの位置受信と、xangiからの位置参照
- 最新位置1件の保存と、経過時間による鮮度判定
- 本人の位置が必要な依頼で参照する会話用スキル

## 導入

Node.js 22以上、xangi、iPhoneのOwnTracks、HTTPS受信口が必要です。
[使い方ガイド](docs/usage.md)に沿って、サーバーとiPhoneを設定してください。

## ドキュメント

- [使い方・設定・トラブルシューティング](docs/usage.md)
- [アーキテクチャ・API・保存形式](docs/design.md)
- [xangiからのセットアップ入口](XANGI_SETUP.md)

## License

[MIT](LICENSE)
