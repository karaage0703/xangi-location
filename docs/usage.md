# 使い方ガイド

xangi-locationの導入・設定・操作を説明します。内部構造は[設計](design.md)を参照してください。

## 目次

- [必要な環境](#必要な環境)
- [サーバー側](#サーバー側)
- [iPhone側](#iphone側)
- [接続後の検証](#接続後の検証)
- [停止・復旧](#停止復旧)
- [設定項目](#設定項目)
- [位置の参照](#位置の参照)
- [利用上の制限](#利用上の制限)
- [トラブルシューティング](#トラブルシューティング)
- [開発と検証](#開発と検証)

## 必要な環境

- Node.js 22以上。拡張の追加依存はありません。
- managed-http拡張と`extension_request`に対応するxangi。
- OwnTracksを導入したiPhoneと、認証ヘッダーを保持できるHTTPS受信口。
- 本人用のxangiインスタンス。共有インスタンスでの利用者別認可については[利用上の制限](#利用上の制限)を確認してください。

この手順は導入担当者向けです。ローカル実装・テストの完了は配備の完了を意味しません。対象xangi・workspace・HTTPS公開先を決め、既存の許可範囲で設定・拡張登録・起動・プロキシ変更を行ってください。本体の再起動は必要になった場合に別途判断します。コマンド中の`/absolute/path/to/xangi/bin/xangi`は対象インスタンスのCLIの絶対パスへ置き換えます。

## サーバー側

1. 稼働用checkoutを用意します。[config.example.json](../config.example.json)を非公開の`config.json`へコピーし、ファイル権限を600にします。`password`を24文字以上のランダムな値に置き換えてください。例のパスワードでは起動しません。認証情報をチャット・コマンド引数・ログへ載せないでください。
2. `dataDir`を拡張専用の保存先にします。相対パスはconfigファイルの場所が基準です。このディレクトリ全体の権限が700になります。workspaceのroot・他のアプリの共有ディレクトリは指定しません。
3. `username`、`deviceId`をiPhoneと合わせます。英数字・`_`・`-`の1～64文字です。初期例は`owner`と`iphone`です。`ingestPort`は空いている固定port、`maxAgeSeconds`は鮮度の目安（初期例30分）です。
4. 親xangiから拡張へ`XANGI_LOCATION_CONFIG=/absolute/path/to/config.json`を渡すようにします。設定変更の反映方法は対象環境の運用に従います。
5. 拡張操作の前に以下で現在のCLIの引数を確認し、そのhelpに従ってmanifestを登録・起動します。ここには未確認のlink引数を記載していません。

   ```bash
   "/absolute/path/to/xangi/bin/xangi" extension --help
   ```

6. HTTPS公開先を用意し、**`POST /pub`だけ**を`http://127.0.0.1:<ingestPort>/pub`へ転送します。Authorizationヘッダーを保持し、プロキシのrequest body・Authorization・URLのクエリをログへ残さない設定にします。受信口へ別の認証画面を挟むとOwnTracksが送れません。参照用の動的portやxangi本体をこの受信口で公開しないでください。プロキシ側もbody上限を設定できます（拡張側は8 KiB）。
7. [同梱スキル](../skills/xs-xangi-location/SKILL.md)を対象workspaceのスキル領域へ配置します。複数人が利用する環境では、この利用者の位置を読めるworkspace・会話を限定します。拡張自体はxangiで有効になった全会話から呼べるため、workspace別の利用者認可が必要な共有インスタンスにはそのまま導入しないでください。

## iPhone側

1. OwnTracksの位置情報を「常に」、正確な位置情報を必要に応じてオンにします。更新モード`monitoring=1`はSignificantです。
2. OwnTracksのSettingsでModeをHTTPにし、URLに`https://<公開先>/pub`を入力します。URLへユーザー名・パスワードやクエリを埋め込みません。
3. UserIDとPasswordの欄にサーバー側の`username`と`password`、DeviceIDに`deviceId`を入れます。認証を有効にします。TrackerIDは端末識別の照合には使いません。
4. Secret encryption keyは空欄にします。この拡張はOwnTracks独自のペイロード暗号化を復号しません。通信保護はHTTPSで行います。
5. 最初は手動で現在位置をPublishします。データには`topic=owntracks/<username>/<deviceId>`、または一致する`X-Limit-U` / `X-Limit-D`ヘッダーが必要です。送信エラーの場合はUserID・DeviceIDとtopicの一致も確認します。

## 接続後の検証

```bash
"/absolute/path/to/xangi/bin/xangi" tool extension_request --id xangi-location --capability location.read --path /location
```

- 手動Publish後に`missing`から位置データへ変わること、取得時刻と精度が妥当なことを確認します。実座標を公開チャットへ貼り付けません。
- iPhoneをロックし、移動後に同じコマンドで`observedAt`が更新されることを確認します。Significantは固定周期の更新を保証しません。
- 未認証の受信が401、受信用パスワードによる位置の読み出しができないことをHTTPS公開先でも確認します。
- 受信停止後の古い位置をxangiが「現在地」と断定せず、経過時間を伝えることを確認します。

HTTPモードのこの構成では、xangiからiPhoneを任意の瞬間に起こして測位させません。OSによる遅延があるため、必要なら本人がOwnTracksで手動Publishします。

## 停止・復旧

拡張停止で受信と参照の両listenerが終了します。保存失敗は500を返し、未保存の位置は成功として扱いません。起動時に保存ファイルの破損・利用者/端末の不一致を検知した場合は起動を失敗させます。設定と保存先を確認し、位置データの削除・入れ替えは本人の意図を確認して行ってください。保存先の変更や削除を勝手に復旧手順へ含めません。

## 設定項目

`XANGI_LOCATION_CONFIG`は親xangiから渡す設定ファイルのパスです。内容は次の項目を持つJSONです。

| 項目 | 内容 |
| --- | --- |
| `dataDir` | 拡張専用の保存先。相対パスは設定ファイルの場所が基準。ディレクトリ700、保存ファイル600 |
| `ingestPort` | loopbackで待ち受ける固定port。1〜65535から空いている値を選ぶ。例は18991 |
| `username` | OwnTracksのUserID。英数字・`_`・`-`の1〜64文字 |
| `password` | 24文字以上のランダムな送信用パスワード。例のプレースホルダーでは起動しない |
| `deviceId` | OwnTracksのDeviceID。英数字・`_`・`-`の1〜64文字 |
| `maxAgeSeconds` | 鮮度の目安となる正の整数秒。例は1800秒（30分） |

各項目は必須です。設定例の`owner`・`iphone`・portは汎用の例示であり、利用環境に合わせて変更できます。

設定ファイルと`dataDir`はGit・通常ログ・公開バックアップに含めません。`.gitignore`の標準対象外へ配置する場合は、その保存先も追跡対象から外してください。

## 位置の参照

同梱スキルを導入すると、「この近くの店」など本人の位置が必要な依頼で、接続後の検証と同じAPIを参照できます。CLIが参照用トークンを付けるため、手動指定は不要です。

- `missing`: 位置未受信。`location`はnullです。
- `fresh`: GPS取得から`maxAgeSeconds`以内です。今も同じ場所にいる保証ではありません。
- `stale`: 閾値を超えた最終測位です。経過時間を伝え、その位置でよいか確認するか、手動Publishを案内します。

`ageSeconds`はGPS取得からの経過秒数です。`location.observedAt`はGPS取得時刻、`receivedAt`はサーバー受信時刻で、いずれもUnix秒です。`accuracyMeters`は精度の目安で、nullなら精度不明です。受信が遅れたデータを、受信直後だからという理由で現在位置として扱いません。

## 利用上の制限

- Significantモードは省電力ですが、移動しても即時・固定周期には更新されません。停止中に更新がなく、同じ場所でも`stale`になることがあります。通信断やOSのバックグラウンド制御でも遅延します。
- この拡張は1利用者・1端末用です。導入先xangiでcapabilityを呼べる会話から位置を参照できます。スキルの本人限定指示は、利用者別の技術的なアクセス制御の代替ではありません。
- 最新位置は平文でローカル保存します。OwnTracksのSecret encryption keyによる独自のペイロード暗号化は未対応です。通信はHTTPSで保護します。
- 履歴、毎ターンの位置注入、常時のモデル起動、iPhoneへの任意の瞬間の測位要求は行いません。
- 位置を地名へ変換する外部サービスは呼びません。座標を外部検索に使う場合は、本人の依頼範囲で行います。

## トラブルシューティング

- **401**: UserID・Password・Authenticationと、プロキシがAuthorizationヘッダーを保持しているかを確認します。
- **404**: URLとプロキシ転送先を確認します。拡張の受信先は`POST /pub`で、クエリは付けません。公開パスにprefixがある場合は、転送時に取り除きます。
- **413 / 415 / 422**: payload上限、Content-Type、JSON・座標・時刻・端末識別の不一致、未対応の暗号化を確認します。詳細は[設計のHTTP応答](design.md#http応答)を参照してください。
- **500**: 保存先の権限や空き容量を確認します。保存失敗を成功として扱わないため、受信時の位置は更新されません。
- **missing**: 手動Publish、通信状態、公開URLを確認します。healthの成功だけでは測位受信済みを意味しません。
- **stale**: 最後のGPS取得時刻を確認します。OwnTracksのpingでは鮮度を更新しません。
- **起動失敗**: 設定ファイル、例のパスワードが未置換でないか、固定portの競合、保存ファイルの破損・利用者/端末の不一致を確認します。実位置やパスワードを診断ログに貼り付けません。

## 開発と検証

```bash
npm ci
npm run check
npm test
```

Node.jsの標準機能だけを使うためbuild工程はありません。テストでは一時ディレクトリとloopbackの一時portを使い、実端末・外部API・稼働中のxangiには接続しません。managed runtimeのreadyメッセージとstdin終了も実プロセスで検証します。

ビルド済みのxangi checkoutがある場合、一時storeへの登録・起動・参照・停止・再起動も確認できます。終了時に一時データとプロセスを片付け、稼働用設定は使いません。

```bash
npm run test:xangi -- /absolute/path/to/built/xangi-checkout
```
