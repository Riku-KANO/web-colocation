# Deploy on Kubernetes

The Helm chart in [`deploy/helm/web-colocation`](../deploy/helm/web-colocation) installs one pod
with the app (and optionally oauth2-proxy), a ConfigMap with your configuration, a volume for
room state, a Service, and an Ingress or Gateway API HTTPRoute.

```bash
helm install colo oci://ghcr.io/OWNER/charts/web-colocation -n xr --create-namespace -f values.yaml
helm upgrade colo oci://ghcr.io/OWNER/charts/web-colocation -n xr -f values.yaml
```

Works with Helm 3.15+ and Helm 4, Kubernetes 1.29+ (native sidecars).

## What you need

| | |
|---|---|
| **HTTPS** | headsets only allow WebXR on secure pages. Terminate TLS at the load balancer. |
| **Long-lived WebSockets** | raise the load balancer idle/backend timeout (an hour is fine). |
| **A volume** | 1 GiB `ReadWriteOnce` is plenty (room state is small JSON). |
| **SSO (optional)** | an OAuth client at your IdP — see [auth.md](auth.md). |
| **TURN (optional)** | for voice across strict firewalls — see [turn.md](turn.md). |

## Single replica

Rooms live in the memory of one process, so the chart always runs **one replica** with the
`Recreate` strategy (never two pods side by side). On a deploy or node drain:

1. the pod stops being ready and `preStop` waits `preStopSleepSeconds` (10 s) so the load
   balancer stops sending new connections;
2. the app closes WebSockets with code 1012 and writes all room state to the volume;
3. the new pod starts and restores the rooms; browsers reconnect automatically (a few seconds).

One pod handles hundreds of participants (see [operations.md](operations.md#capacity)).
Multi-replica support (Redis) is on the [roadmap](roadmap.md).

## Exposing the app

### Amazon EKS — AWS Load Balancer Controller

[`deploy/examples/eks-alb.yaml`](../deploy/examples/eks-alb.yaml):

```yaml
ingress:
  enabled: true
  className: alb
  annotations:
    alb.ingress.kubernetes.io/scheme: internal
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:...
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600
    alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=30
    alb.ingress.kubernetes.io/healthcheck-path: /healthz        # /ping with oauth2Proxy.enabled
```

### Google GKE — GCE Ingress

[`deploy/examples/gke-ingress.yaml`](../deploy/examples/gke-ingress.yaml). The chart creates a
`BackendConfig` that raises the 30-second backend timeout (which would otherwise cut every
WebSocket) and sets the health check. Use a `ManagedCertificate` for TLS.

### Gateway API (Envoy Gateway, GKE Gateway, AWS LBC Gateway, NGINX Gateway Fabric …)

[`deploy/examples/gateway-api.yaml`](../deploy/examples/gateway-api.yaml) creates an `HTTPRoute`
attached to your Gateway. Make sure the implementation's request/idle timeouts allow long-lived
WebSockets (e.g. `GCPBackendPolicy.timeoutSec` on GKE, `BackendTrafficPolicy` timeouts on
Envoy Gateway).

> ingress-nginx was retired in March 2026; prefer a Gateway API implementation for new
> clusters. Existing ingress-nginx installs work with `ingress.className: nginx` and the
> `nginx.ingress.kubernetes.io/proxy-read-timeout` / `proxy-send-timeout` annotations.

## Configuration

Everything under `config:` becomes the app's config file (see [configuration.md](configuration.md)).
The chart fills in the parts that depend on the deployment: `storage` (from `persistence`),
`assets.dir`, `auth` (when `oauth2Proxy.enabled`), `server.publicUrl` (from the ingress host) and
`voice.turn.secretEnv`. `helm install` validates `config:` against the schema.

Config changes are applied **without restarting the pod** (the app watches the ConfigMap).
Kubernetes updates mounted ConfigMaps within about a minute.

To manage the config yourself (e.g. with Kustomize), create a ConfigMap with a `config.yaml` key
and set `existingConfigMap`.

## Assets

Logos and 3D models are served from `/room-assets/`. Mount them with either:

```yaml
assets:
  existingClaim: colo-assets      # a PVC you fill (e.g. with kubectl cp or a sync job)
  # configMap: colo-logos         # small files only (1 MiB total), as binaryData
```

or host them on an https origin and list it in `config.assets.allowedOrigins`.

## SSO

```yaml
oauth2Proxy:
  enabled: true
  provider: google                # google | entra-id | oidc | keycloak-oidc | github | gitlab ...
  clientId: ...
  existingSecret: colo-oauth2     # keys: client-secret, cookie-secret
  emailDomains: [acme.example]    # required (or allowedGroups); ["*"] only for single-tenant providers
```

oauth2-proxy runs as a native sidecar in the same pod; the app listens only on `127.0.0.1` so the
identity headers cannot be forged from outside. Point load balancer health checks at `/ping`.
Details: [auth.md](auth.md).

## Security defaults

- non-root (uid 1000), read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp
- no service account token mounted
- optional `NetworkPolicy` (`networkPolicy.enabled`, `networkPolicy.ingressFrom`)
- the health port (8081) exposes only `/healthz`, `/readyz` and `/metrics` (which is not served
  on the public port)
- an enforced Content-Security-Policy and `X-Frame-Options`
- set `config.server.trustedProxyHops` for your load balancer (see the examples) so passcode
  rate limiting tells clients apart; details in [auth.md](auth.md#passcodes)

## Monitoring

Prometheus can scrape `/metrics` on port 8081 (`colo_rooms`, `colo_participants`,
`colo_ws_open_connections`, rejected upgrades, join errors). See [operations.md](operations.md).

## Verifying a chart change locally

```bash
scripts/kind-smoke.sh
```

builds the image, dry-runs every example against a kind cluster, installs the chart, runs
`helm test`, checks the CSP and WebSocket sync, and performs a full SSO login with dex and the
oauth2-proxy sidecar. It uses its own kubeconfig and never changes your current context.

## Values

See [`values.yaml`](../deploy/helm/web-colocation/values.yaml) for all chart values with comments.
