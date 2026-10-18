# Kubernetes への導入

[`deploy/helm/web-colocation`](../../deploy/helm/web-colocation) の Helm チャートは、次のものを作ります。

- アプリの Pod 1 つ (oauth2-proxy を同じ Pod に入れることもできます)
- 設定の ConfigMap
- 部屋の状態を保存するボリューム
- Service
- Ingress または Gateway API の HTTPRoute

インストール:

```bash
helm install colo oci://ghcr.io/OWNER/charts/web-colocation -n xr --create-namespace -f values.yaml
```

更新:

```bash
helm upgrade colo oci://ghcr.io/OWNER/charts/web-colocation -n xr -f values.yaml
```

対応バージョン: Helm 3.15 以上または Helm 4、Kubernetes 1.29 以上 (ネイティブサイドカーを使うため)。

## 必要なもの

| 項目 | 説明 |
|---|---|
| **HTTPS** | ヘッドセットは安全なページでしか WebXR を使えません。TLS はロードバランサーで終端します。 |
| **長時間の WebSocket** | ロードバランサーのアイドル / バックエンドのタイムアウトを延ばします (1 時間程度)。 |
| **ボリューム** | ReadWriteOnce で 1 GiB あれば十分です (部屋の状態は小さな JSON)。 |
| **SSO** (任意) | IdP に OAuth クライアントを登録します。 |
| **TURN** (任意) | 厳しいファイアウォール越しに音声を通す場合に必要です ([turn.md](../turn.md))。 |

## レプリカは 1 つ

部屋の状態は 1 プロセスのメモリにあるため、チャートは常に **1 レプリカ**で動かします。更新方式は `Recreate` で、2 つの Pod が同時に動くことはありません。

更新やノードのドレインのときは、次の順で入れ替わります。

1. Pod が Ready でなくなります。`preStop` で 10 秒待つ間に、ロードバランサーが新しい接続を送らなくなります。
2. アプリが WebSocket を 1012 で閉じ、すべての部屋の状態をボリュームに書き出します。
3. 新しい Pod が起動して状態を復元します。ブラウザは数秒で自動的に再接続します。

1 Pod で数百人規模まで扱えます。容量の目安は [operations.md](../operations.md#capacity) を参照してください。複数レプリカ (Redis) は今後の予定です。

## 公開方法

### Amazon EKS (AWS Load Balancer Controller / ALB)

[`deploy/examples/eks-alb.yaml`](../../deploy/examples/eks-alb.yaml) を使います。

- 証明書は ACM で用意します (`certificate-arn`)。
- `idle_timeout.timeout_seconds=3600` で WebSocket が切れないようにします。
- ヘルスチェックのパスは `/healthz` です (SSO を使う場合は `/ping`)。

### Google GKE (GCE Ingress)

[`deploy/examples/gke-ingress.yaml`](../../deploy/examples/gke-ingress.yaml) を使います。

- チャートが `BackendConfig` を作ります。既定のバックエンドタイムアウトは 30 秒で、そのままだとすべての WebSocket が切られるため、これを延ばします。ヘルスチェックも設定します。
- 証明書には ManagedCertificate を使います。

### Gateway API

Envoy Gateway / GKE Gateway / AWS LBC Gateway / NGINX Gateway Fabric などで使えます。

- [`deploy/examples/gateway-api.yaml`](../../deploy/examples/gateway-api.yaml) で HTTPRoute を作ります。
- 実装ごとのタイムアウト設定で、長時間の WebSocket を許可してください。

> ingress-nginx は 2026 年 3 月に保守が終了しました。新しいクラスターでは Gateway API の実装を使ってください。

## 設定

values の `config:` 以下が、アプリの設定ファイルになります ([設定ガイド (英語)](../configuration.md))。

- 次の項目は、チャートの他の values から自動で決まります。
  - `storage` (`persistence` から)
  - `assets.dir`
  - `auth` (`oauth2Proxy.enabled` のとき)
  - `server.publicUrl` (Ingress のホスト名から)
  - `voice.turn.secretEnv`
- `helm install` の時点で `config:` をスキーマで検証します。間違いがあれば、その場所を示してエラーになります。
- 設定の変更は **Pod を再起動せずに** 反映されます。アプリが ConfigMap を監視しており、更新はおおむね 1 分以内に届きます。

## アセット (ロゴ・3D モデル)

`/room-assets/` で配信されます。置き方は次のどれかです。

```yaml
assets:
  existingClaim: colo-assets      # ファイルを置いた PVC
  # configMap: colo-logos         # 小さなファイルだけ (合計 1 MiB まで、binaryData)
```

https で公開されたファイルを使う場合は、そのオリジンを `config.assets.allowedOrigins` に書きます。

## SSO (oauth2-proxy)

```yaml
oauth2Proxy:
  enabled: true
  provider: google                # google | entra-id | oidc ...
  clientId: ...
  existingSecret: colo-oauth2     # キー: client-secret, cookie-secret
  emailDomains: [acme.example]
```

Secret は次のように作ります。

```bash
kubectl -n xr create secret generic colo-oauth2 \
  --from-literal=client-secret='<IdP の値>' \
  --from-literal=cookie-secret="$(openssl rand -hex 16)"
```

- IdP にはリダイレクト URI `https://<ホスト>/oauth2/callback` を登録します。
- oauth2-proxy は同じ Pod のネイティブサイドカーとして動きます。
- アプリは `127.0.0.1` だけで待ち受けるので、外部から識別ヘッダを偽装できません。

主催者 (hosts / admins)、入室の許可リスト、パスコードについては [auth.md (英語)](../auth.md) を参照してください。

## セキュリティの既定値

- 非 root (uid 1000)、読み取り専用のルートファイルシステム、全 capability の削除、seccomp RuntimeDefault
- サービスアカウントのトークンはマウントしません
- NetworkPolicy は任意です (`networkPolicy.enabled`)
- ヘルスチェック用ポート (8081) は `/healthz`、`/readyz`、`/metrics` だけを提供します

## ローカルでの確認

```bash
scripts/kind-smoke.sh
```

このスクリプトは kind 上で次を行います。

- イメージをビルドする
- 全設定例を dry-run する
- チャートをインストールし、`helm test` を実行する
- CSP と WebSocket の同期を確認する
- dex と oauth2-proxy による SSO ログインを最後まで確認する

専用の kubeconfig を使うので、普段の kubectl のコンテキストは変わりません。
