# web-colocation

**自社のインフラで動かせる WebXR ミーティングルーム**です。Meta Quest、Android XR、Apple Vision Pro、普通のブラウザから参加できます。参加者は共有の机を囲み、次のことができます。

- 物を動かす
- ペンでホワイトボードに書く
- 空間音声で話す

同じ部屋にいる人同士はヘッドセットの位置を合わせられるので、仮想の物が実物の机の上にそろって見えます。

[English README](README.md)

## 主な機能

- **共有空間**: 物・ペン・ホワイトボードが全員で同期します。同時に掴んだときは先着が優先され、他の人には動いて見えます。
- **コロケーション**:
  - 離れた場所の人は、自分の机に部屋を置きます。
  - 同じ部屋の人は 2 点をタッチして位置合わせします。全員の仮想の机が実物の机と一致します。
- **カスタマイズできる部屋**:
  - 机・席・ボード・持ち込み 3D モデル (glTF)・背景・ルールを YAML のテンプレートで定義できます。
  - 主催者はアプリ内でも部屋の設定を変えられます。
- **社内利用向け**:
  - oauth2-proxy 経由の SSO (Google Workspace / Entra ID / Okta / 任意の OIDC)
  - 主催者と参加者の役割、入室の許可リスト、パスコード
  - 短命クレデンシャルによる TURN、状態の永続化
- **導入が簡単**:
  - コンテナ 1 つと Helm チャート 1 つで動きます。
  - EKS (ALB)、GKE、Gateway API 向けの設定例を同梱しています。
  - 設定の変更は再起動せずに反映されます。

> 状態: v0.2 (プレリリース)。WebXR エミュレータと kind で検証済みです。実機と実クラウドでの結果を issue でお知らせください。

## ローカルで試す

```bash
npm install
```

```bash
npm run dev
```

http://localhost:5173 を 2 つのタブで開き、同じルームに入って物を動かしてみてください。URL に `&emulate=quest3` を付けると、ヘッドセットが無くても XR モードを試せます。

Docker で起動する場合 (サンプルのルームと 3D モデル付き):

```bash
docker compose up --build
```

http://localhost:8080 を開いてください。

SSO のデモ (dex + oauth2-proxy。ユーザー `alice@example.com`、パスワード `password`):

```bash
docker compose -f compose.yaml -f deploy/compose/sso.compose.yaml up --build
```

http://localhost:4180 を開いてください。

## Kubernetes に導入する

```bash
helm install colo oci://ghcr.io/OWNER/charts/web-colocation -n xr --create-namespace -f my-values.yaml
```

[`deploy/examples/`](deploy/examples) の設定例から始めてください。

- `eks-alb.yaml`
- `gke-ingress.yaml`
- `gateway-api.yaml`
- `oauth2-proxy-google.yaml`
- `oauth2-proxy-entra.yaml`

ヘッドセットで使うには **HTTPS が必須**です。詳しくは [docs/ja/deploy-kubernetes.md](docs/ja/deploy-kubernetes.md) を参照してください。

```yaml
# my-values.yaml (抜粋)
config:
  branding: { productName: Acme XR Rooms, logo: /room-assets/logo.svg }
  rooms:
    list:
      - id: design-review
        title: { en: Design review, ja: デザインレビュー }
        template: workshop
        hosts: [lead@acme.example]
oauth2Proxy: { enabled: true, provider: google, clientId: ..., existingSecret: colo-oauth2 }
ingress: { enabled: true, className: alb, hosts: [{ host: xr.acme.example, paths: [{ path: /, pathType: Prefix }] }] }
```

## ヘッドセットでの使い方

1. ヘッドセットのブラウザでサイト (HTTPS) を開き、ルームを選んで **AR で入る** (または VR) を押します。
2. 目の前に部屋が現れます。左手首のパネルで部屋の置き方を選べます。
   - **ここに机 (1点)**: 自分の机の中心をタッチすると、その机の上に部屋を置けます。
   - **同室合わせ (2点)**: 同じ部屋にいる全員が、同じ 2 点を同じ順番でタッチします。例えばテーブルの左右の短辺の中点です。
3. トリガーかピンチで物を掴みます。ペンを持ってボードに先端を当てると書けます。

PC での操作:

| 操作 | 動作 |
|---|---|
| ドラッグ | 移動 |
| Shift+ドラッグ | 上下に動かす |
| ドラッグ中にホイール | 回転 |
| ボード上でドラッグ | 描く |

## ドキュメント

日本語のドキュメント:

| ドキュメント | 内容 |
|---|---|
| [はじめに](docs/ja/getting-started.md) | ローカル開発、ヘッドセットでの確認、エミュレータ |
| [Kubernetes への導入](docs/ja/deploy-kubernetes.md) | Helm、EKS / GKE / Gateway API、SSO、TURN |
| [部屋テンプレート](docs/ja/room-templates.md) | レイアウト、家具、ボード、3D モデル、ルール |
| [設計](docs/ja/architecture.md) | 仕組みの概要 |
| [実現可能性の検討](docs/ja/feasibility.md) | 調査メモ |

英語のみのドキュメント:

| ドキュメント | 内容 |
|---|---|
| [Configuration](docs/configuration.md)、[reference](docs/configuration-reference.md) | 設定ファイルと全オプション |
| [Authentication](docs/auth.md) | 認証とアクセス制御 |
| [Voice and TURN](docs/turn.md) | 音声と TURN |
| [Operations](docs/operations.md) | 監視・バックアップ・容量 |
| [Protocol](docs/protocol.md) | ネイティブクライアント向けの通信仕様 |
| [Troubleshooting](docs/troubleshooting.md) | よくある問題 |
| [Roadmap](docs/roadmap.md) | 今後の予定 |

## コントリビュート

issue や pull request を歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。脆弱性の報告は [SECURITY.md](SECURITY.md) の手順に従ってください。

## ライセンス

[Apache License 2.0](LICENSE)
