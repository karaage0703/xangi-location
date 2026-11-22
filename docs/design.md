# 設計ドキュメント

xangi-locationの内部構造・API・保存形式を説明します。導入手順・設定例・利用時の制限は[使い方](usage.md)へまとめています。

## 概要

OwnTracksからの受信を、xangi本体から独立したmanaged-http拡張として実装します。受信部分は`src/server.mjs`、位置の検証・保存・鮮度判定は`src/location.mjs`が担当します。外部依存はありません。

```text
iPhone / OwnTracks
  └─ HTTPS + Basic認証 → reverse proxy（POST /pubのみ転送）
       └─ 127.0.0.1:設定した固定port /pub
            └─ LocationStore → 専用dataDir/latest.json
xangi / extension_request
  └─ managed runtimeのBearer認証
       └─ 127.0.0.1:動的port /location → 最新位置・経過秒数・状態
```

## 認証境界と起動

- 受信listenerと参照listenerを分離し、両方ともloopbackへbindします。受信は設定済みのUserID・PasswordによるBasic認証、参照は`XANGI_EXTENSION_AUTH_TOKEN`によるBearer認証です。送信用パスワードでは参照できません。
- TLSは外側のHTTPSプロキシが終端します。受信listenerは`POST /pub`だけを提供し、位置の読出しAPIを公開しません。
- `xangi-extension.json`は`location.read` capabilityを宣言します。親xangiはentrypointを`serve --workspace <workspace>`で起動し、トークンを渡します。
- 設定・保存状態の読込と両listenerの起動後、stdoutへschemaVersion=2のreadyメッセージを1行出します。`baseUrl`は参照listener、`workspace`は起動対象です。
- 固定portが競合すると起動を失敗させます。stdin終了・SIGTERM・SIGINTでは両listenerを閉じます。
- `GET /health`はプロセスの準備状態であり、位置の取得済み・鮮度を示すものではありません。

capabilityを呼べるxangi内の会話ごとの利用者認可は追加していません。導入先の制限は[使い方](usage.md#利用上の制限)を参照してください。

## 受信から保存まで

1. Basic認証、HTTP method・path、Content-Type（`application/json`）を検証します。本文は8 KiBまで、request timeoutは15秒です。
2. JSONを解析します。空payloadと、文字列の`_type`を持つlocation以外のメッセージは`[]`で応答して保存しません。ただし`_type=encrypted`は未対応として拒否します。
3. locationでは、`topic=owntracks/<username>/<deviceId>`または一致する`X-Limit-U`・`X-Limit-D`ヘッダーで設定端末を照合します。topicとヘッダーの両方がある場合、矛盾を許しません。
4. `lat`・`lon`は数値かつ緯度±90・経度±180、`tst`は正の整数Unix秒として検証します。取得時刻がサーバー時刻の60秒先を超える場合は拒否します。`acc`は省略・nullなら精度不明、それ以外は0〜1,000,000の有限値を受け付けます。
5. `t=p`のpingと、保存済みの取得時刻以下のデータは保存せずに成功応答します。pingは新しい時刻でも新しいGPS測位を表さない場合があり、重複・遅延配信も最新位置を置き換えないためです。
6. 保存対象の項目だけを一時ファイルへ書き、renameで最新ファイルに置き換えます。保存成功後にメモリ上の最新位置も更新し、`[]`を返します。保存失敗ではメモリ上の位置も更新しません。

## 保存形式と鮮度

`dataDir/latest.json`は最新1件です。専用ディレクトリは700、ファイルは600にします。保存するのは次の項目です。

| 項目 | 内容 |
| --- | --- |
| `username`, `deviceId` | 設定済みの利用者・端末識別子 |
| `latitude`, `longitude` | 測位の緯度・経度 |
| `accuracyMeters` | 精度の目安。未指定ならnull |
| `observedAt` | OwnTracksの`tst`、GPS取得時刻 |
| `receivedAt` | サーバーで受信・検証した時刻 |

SSID・メモ・画像・電池残量などの追加情報は保存しません。履歴DBも作りません。起動時は保存ファイルを検証して復元し、破損や設定利用者・端末との不一致では起動を失敗させます。

`ageSeconds = max(0, 現在時刻 - observedAt)`で経過秒数を求め、`maxAgeSeconds`以内なら`fresh`、超過なら`stale`です。未受信なら`missing`と`location=null`を返します。`receivedAt`で鮮度を更新しないため、遅れて届いた測位を新しい現在位置として扱いません。

参照応答の例（架空の座標）:

```json
{
  "status": "fresh",
  "ageSeconds": 120,
  "maxAgeSeconds": 1800,
  "location": {
    "username": "owner",
    "deviceId": "iphone",
    "latitude": 35.5,
    "longitude": 139.5,
    "accuracyMeters": 12,
    "observedAt": 1790000000,
    "receivedAt": 1790000120
  }
}
```

## HTTP応答

参照listenerは`GET /health`と`GET /location`、受信listenerは`POST /pub`を提供します。成功応答は200です。どちらも`Cache-Control: no-store`を付けます。

| 応答 | 条件 |
| --- | --- |
| 401 | 対応するlistenerの認証情報が不一致 |
| 404 | 認証後のmethod・pathが対象外 |
| 413 | 受信本文が8 KiBを超える |
| 415 | 受信のContent-Typeがapplication/jsonではない |
| 422 | 不正JSON、位置・時刻・端末識別の不一致、未対応のpayload暗号化 |
| 500 | 保存失敗などの内部エラー |

内部エラーへ座標・認証情報・リクエスト本文・保存先パスを含めません。受信listenerから参照listenerへ転送する経路はありません。

## 検証方針

HTTPテストでは認証分離、端末照合、鮮度・遅延・ping、入力上限、保存失敗、保存情報の最小化を確認します。実プロセスのテストではready handshakeとstdin終了を確認します。別のビルド済みxangiを使う互換性確認は、一時storeで拡張を登録・起動・参照・停止・再起動して保存位置を復元します。実行方法は[使い方](usage.md#開発と検証)にあります。

## 仕様の参照先

- [OwnTracks HTTP](https://owntracks.org/booklet/tech/http/): Basic認証、成功時の`[]`、空payload、端末識別
- [OwnTracks JSON](https://owntracks.org/booklet/tech/json/): `lat`・`lon`・`acc`・`tst`、pingの時刻
- [OwnTracks Location](https://owntracks.org/booklet/features/location/): iOSの更新モード
