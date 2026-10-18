# 部屋テンプレート

テンプレートは部屋のレイアウトをまとめて定義するものです。

- 共有原点の位置
- 家具 (机)
- 席
- ホワイトボード
- 机の上の物
- 背景
- ルール

各ルームはテンプレートを 1 つ選びます (`rooms.list[].template`)。主催者はアプリ内でテンプレートを切り替えられます。

## 組み込みテンプレート

| id | レイアウト | 席 | ボード |
|---|---|---|---|
| `standard` | 長方形の机。端にボード | 7 | 1 |
| `round-table` | 丸テーブル。席は円形 | 6 | 1 |
| `workshop` | 長机。両端にボード | 8 | 2 |
| `presentation` | 机なし。発表者の位置、客席 2 列、大きなボード | 9 | 1 |

定義は [`server/config/templates.ts`](../../server/config/templates.ts) にあり、設定ファイルと同じ書式なので作例として使えます。

## 共有座標系

位置はすべて部屋の**共有座標系**で書きます。単位はメートル、+Y が上の右手系です。原点の位置は `anchor` で決まります。

- `anchor: { kind: table, floorOffset: 0.72 }`
  - 原点は **主テーブルの天板の中心**で、床から 0.72 m の高さです。
  - 「ここに机 (1点)」ではこの点を自分の机に合わせます。同室合わせでは、タッチした 2 点の中点がこの点になります。
- `anchor: { kind: floor, floorOffset: 0 }`
  - 原点は床の上です (机の無い部屋)。

角度の書き方:

- 単位は度です。
- `yaw: 0` は **-Z の方向**を向きます。正の値で、上から見て反時計回りに回ります。
- `yaw` を省いた席は原点の方を向きます。`lookAt: [x, z]` で向く先を指定することもできます。

## 書き方

```yaml
templates:
  - id: product-demo
    extends: round-table          # 別のテンプレートを元にする (任意)
    title: { en: Product demo, ja: 製品デモ }
    environment:                  # 元のテンプレートと統合される
      background: "#1f2430"
      floor: plain                # grid | plain | none
    addObjects:                   # 元の物に追加 (objects: と書くと置き換え)
      - id: drone
        kind: model
        position: [0, 0.02, 0.4]
        rotation: [0, 45, 0]      # オイラー角 (度、X, Y, Z)
        model: { src: /room-assets/drone.glb, scale: 1.2 }
    rules:
      maxParticipants: 6
      permissions: { clearBoard: hosts }
```

| 項目 | 説明 |
|---|---|
| `tables[]` | `shape: rect` (`width`、`depth`) か `round` (`width` が直径)。`height` は床からの高さ。`x`、`z`、`yaw`、`color` |
| `seats` | `{ x, z, yaw?, lookAt? }` の一覧、または円形に並べる `{ auto: { count, radius, startAngle } }` |
| `boards[]` | `{ id, x, y, z, yaw, width, height, background }`。`y` はボードの中心。yaw 0 で +Z を向く |
| `objects[]` / `addObjects[]` | `kind: cube \| sphere \| cone \| torus \| pen \| model`、`position`、`rotation`、`scale`、`color` |
| `rules` | `maxParticipants`、`voice.enabled`、`permissions.{clearBoard,resetObjects,editSettings}` |

`extends` を使ったときの扱い:

- `environment` と `rules` は、元のテンプレートと統合されます。
- `tables`、`seats`、`boards`、`objects` は置き換えになります。物を足すときは `addObjects` を使います。
- id はテンプレート内で重複させないでください。
- 席の数が、その部屋に入れる人数の上限になります。

## 持ち込み 3D モデル

`kind: model` の物は glTF 2.0 を読み込みます。`.glb` を推奨し、Meshopt 圧縮にも対応しています。

```yaml
- id: engine
  kind: model
  position: [0.2, 0, -0.1]
  model:
    src: /room-assets/engine.glb    # または https://models.acme.example/engine.glb
    scale: 0.5
```

置き場所:

- `assets.dir` に置いたファイルは `/room-assets/` で配信されます。
- https の URL を使う場合は、そのオリジンを `assets.allowedOrigins` に書きます。

ブラウザは次のモデルを読み込まず、代わりに仮の箱を表示します。

- `assets.maxModelBytes` (既定 25 MB) を超えるもの
- 50 万三角形を超えるもの
- 4096 px を超えるテクスチャを持つもの

サンプルモデル (`examples/room-assets/drone.glb`) は `npm run make:sample-model` で生成できます。

設定項目の一覧は [configuration-reference.md](../configuration-reference.md) を参照してください (英語)。
