# はじめに

## 必要なもの

- Node.js **23.6 以上**
  - サーバーは TypeScript をそのまま実行します。開発には Node 26 を使っています。
- コンテナで動かすなら Docker。Kubernetes なら Helm 3.15 以上、または Helm 4。

## 開発サーバー

アプリ・API・WebSocket が 1 つのポートで動きます (http://localhost:5173)。

```bash
npm install
```

```bash
npm run dev
```

サンプル設定 (ブランディング・ルーム一覧・3D モデル) 付きで起動する場合:

```bash
npm run dev:example
```

2 つのタブで同じルームに入り、物を動かしたりボードに描いたりしてみてください。

URL パラメータの例:

- `?room=demo&name=Alice&autojoin=1`: ロビーを飛ばして入室します。
- `&lang=ja` / `&lang=en`: 表示言語を切り替えます。

| PC の操作 | 動作 |
|---|---|
| 物をドラッグ | 水平に移動 |
| Shift + ドラッグ | 上下に移動 |
| ドラッグ中にホイール、または Q / E | 回転 |
| ボード上でドラッグ | 描く (色は画面下で選択) |
| それ以外のドラッグ / ホイール | 視点の回転 / ズーム |

## ヘッドセット無しで XR を試す

URL に `&emulate=quest3` を付けて **AR で入る** を押すと、Meta の IWER (WebXR エミュレータ) が Quest 3 を模擬します。

コントローラーはブラウザのコンソールから操作できます。

```js
const r = __xrDevice.controllers.right;
r.position.set(0.3, 0.8, -1.1);
r.updateButtonValue('trigger', 1);   // 掴む / 押す
```

`window.__colo.debugState()` を実行すると、クライアントの状態の要約が得られます。

## ヘッドセットで開く

WebXR は安全なページでしか動きません。次のどちらかの方法を使ってください。

**A. LAN 内で HTTPS (自己署名証明書)**

```bash
npm run dev:https
```

表示された `https://<PC の IP>:5173` をヘッドセットで開き、証明書の警告を承認します。

**B. USB 接続で localhost として開く** (Quest / Android XR)

```bash
adb reverse tcp:5173 tcp:5173
```

この方法では `npm run dev` のまま、ヘッドセットで `http://localhost:5173` を開きます。

補足:

- Android XR の Chrome では、初回に「3D マッピング / カメラトラッキング」の許可を求められます。
- リモートデバッグは、PC の Chrome で `chrome://inspect/#devices` を開いて行います。

### XR 内の操作

| 操作 | 内容 |
|---|---|
| トリガー / グリップ / ピンチ | 近くの物、またはレイが当たった物を掴む |
| ペンを掴む | レイの先にペンが付く。先端をボードに当てると書ける |
| 何も持たずにボードへレイ + トリガー | レイで描く |
| 左手首のパネル (右手のレイで押す) | 部屋の配置、同室合わせ、物を戻す、ボード消去、音声、終了 |

**部屋の置き方**

- **ここに机 (1点)**: 自分の机の中心に先端を当ててトリガーを引きます。各自が別々の場所にいるときに使います。
- **同室合わせ (2点)**: 同じ部屋の全員が、**同じ 2 点を同じ順番で**タッチします。
  - 2 点は離れているほど精度が上がります。
  - ロビーで全員が同じ「同室 ID」を入れておくと、互いのアバターの代わりに名札だけが表示されます。
- **正面に置く**: 部屋を自分の正面に置き直します。

## Docker で動かす

サンプルのルーム付きで起動します (http://localhost:8080):

```bash
docker compose up --build
```

ローカルの TURN サーバー (coturn) も一緒に起動する場合:

```bash
docker compose --profile turn up --build
```

SSO のデモ (http://localhost:4180):

```bash
docker compose -f compose.yaml -f deploy/compose/sso.compose.yaml up --build
```

[`deploy/compose/config.yaml`](../../deploy/compose/config.yaml) を編集すると、起動中のサーバーにそのまま反映されます。

## テスト

ユニットテストと結合テスト:

```bash
npm test
```

型チェック:

```bash
npm run typecheck
```

ブラウザでの E2E (Playwright + XR エミュレータ):

```bash
npm run test:e2e
```

kind 上でのコンテナと Helm の確認 (SSO を含む):

```bash
scripts/kind-smoke.sh
```

次は [Kubernetes への導入](deploy-kubernetes.md) か [部屋テンプレート](room-templates.md) へどうぞ。
