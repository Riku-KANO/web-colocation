#!/usr/bin/env bash
# End-to-end check of the container image and Helm chart on a local kind cluster.
#
#   scripts/kind-smoke.sh            # build image, test, keep the cluster
#   SKIP_BUILD=1 scripts/kind-smoke.sh
#   CLEANUP=1 scripts/kind-smoke.sh  # delete the test namespace afterwards
#
# Steps:
#   1. build the image and load it into kind
#   2. server-side dry-run of every values example (deploy/examples/*.yaml)
#   3. install the chart, wait for readiness, run `helm test`, check headers and WebSocket sync
#   4. install dex + the chart with the oauth2-proxy sidecar and log in end to end
# It uses its own kubeconfig file and never touches ~/.kube/config or your current context.

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLUSTER=${CLUSTER:-colo}
NS=colo-smoke
IMAGE=web-colocation:dev
CHART="$ROOT/deploy/helm/web-colocation"
GATEWAY_API_VERSION=${GATEWAY_API_VERSION:-v1.6.3}
KCFG=${KCFG:-$ROOT/.kind-kubeconfig}
k() { kubectl --kubeconfig "$KCFG" "$@"; }
hl() { helm --kubeconfig "$KCFG" "$@"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --kubeconfig "$KCFG" --wait 180s
fi
kind get kubeconfig --name "$CLUSTER" > "$KCFG"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  step "build $IMAGE"
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
fi
step "load image into kind"
kind load docker-image "$IMAGE" --name "$CLUSTER" >/dev/null
# The tag stays the same between builds, so roll pods whenever the image content changes.
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE" | cut -c8-19)

step "Gateway API CRDs ($GATEWAY_API_VERSION)"
k apply --server-side -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/$GATEWAY_API_VERSION/standard-install.yaml" >/dev/null
k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null

step "server-side dry-run of the examples"
for f in "$ROOT"/deploy/examples/*.yaml; do
  name=$(basename "$f" .yaml)
  extra=()
  # The GKE BackendConfig CRD only exists on GKE; validate the rest of that example here.
  [[ $name == gke-ingress ]] && extra+=(--set gke.backendConfig.enabled=false)
  hl template "dry-$name" "$CHART" -n "$NS" -f "$f" ${extra[@]+"${extra[@]}"} | k apply -n "$NS" --dry-run=server -f - >/dev/null
  echo "ok  $name"
done
hl template dry-gke "$CHART" -n "$NS" -f "$ROOT/deploy/examples/gke-ingress.yaml" --show-only templates/backendconfig.yaml >/dev/null && echo "ok  gke BackendConfig renders"

step "install (no SSO)"
hl upgrade --install colo "$CHART" -n "$NS" -f "$ROOT/deploy/examples/local-kind.yaml" --set-string podAnnotations.image-id="$IMAGE_ID" --wait --timeout 180s >/dev/null
k -n "$NS" rollout status deploy/colo-web-colocation --timeout 120s
hl test colo -n "$NS" --logs | tail -n 2

step "HTTP + WebSocket through the Service"
# Run kubectl directly (not through the `k` function) so $! is kubectl itself and can be killed.
kubectl --kubeconfig "$KCFG" -n "$NS" port-forward svc/colo-web-colocation 18080:80 >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf localhost:18080/healthz >/dev/null && break; sleep 0.5; done
curl -sf localhost:18080/api/config | grep -q '"productName":"Local XR Rooms"' && echo "ok  /api/config"
curl -sI localhost:18080/ | grep -qi '^content-security-policy:' && echo "ok  CSP enforced"
node "$ROOT/test/e2e/ws-sync-check.mjs" ws://localhost:18080/ws
kill $PF 2>/dev/null || true

step "SSO: dex + oauth2-proxy sidecar"
k -n "$NS" apply -f "$ROOT/test/e2e/kind/dex.yaml" >/dev/null
k -n "$NS" rollout status deploy/dex --timeout 120s
hl upgrade --install colo-sso "$CHART" -n "$NS" -f "$ROOT/deploy/examples/local-kind.yaml" \
  --set persistence.enabled=false \
  --set-string podAnnotations.image-id="$IMAGE_ID" \
  --set oauth2Proxy.enabled=true \
  --set oauth2Proxy.provider=oidc \
  --set oauth2Proxy.oidcIssuerUrl=http://dex.$NS.svc.cluster.local:5556/dex \
  --set oauth2Proxy.clientId=colo \
  --set oauth2Proxy.clientSecret=colo-test-secret \
  --set oauth2Proxy.redirectUrl=http://colo-sso-web-colocation.$NS.svc.cluster.local/oauth2/callback \
  --set 'oauth2Proxy.extraArgs={--cookie-secure=false}' \
  --wait --timeout 180s >/dev/null
k -n "$NS" rollout status deploy/colo-sso-web-colocation --timeout 120s
# Run the login flow inside the cluster (where the dex/app service names resolve), using the app
# image because it already contains node and the `ws` package.
k -n "$NS" create configmap sso-check --from-file="$ROOT/test/e2e/sso-check.mjs" --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "$NS" delete pod sso-check --ignore-not-found >/dev/null
k -n "$NS" run sso-check --image="$IMAGE" --image-pull-policy=Never --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"sso-check","image":"'"$IMAGE"'","imagePullPolicy":"Never","command":["node","/app/e2e/sso-check.mjs","http://colo-sso-web-colocation.'"$NS"'.svc.cluster.local"],"workingDir":"/app","volumeMounts":[{"name":"check","mountPath":"/app/e2e"}]}],"volumes":[{"name":"check","configMap":{"name":"sso-check"}}]}}' >/dev/null
k -n "$NS" wait pod/sso-check --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s >/dev/null || { k -n "$NS" logs sso-check; exit 1; }
k -n "$NS" logs sso-check

step "browser E2E on the cluster (example config, assets from a ConfigMap, enforced CSP)"
k -n "$NS" create configmap colo-assets --from-file="$ROOT/examples/room-assets" --dry-run=client -o yaml | k apply -f - >/dev/null
hl upgrade --install colo-e2e "$CHART" -n "$NS" -f "$ROOT/test/e2e/kind/values-e2e.yaml" \
  --set image.repository=web-colocation --set image.tag=dev --set image.pullPolicy=Never \
  --set config.server.csp=enforce --set persistence.size=100Mi \
  --set-string podAnnotations.image-id="$IMAGE_ID" --wait --timeout 180s >/dev/null
kubectl --kubeconfig "$KCFG" -n "$NS" port-forward svc/colo-e2e-web-colocation 18090:80 >/dev/null 2>&1 &
PF=$!
for _ in $(seq 1 30); do curl -sf localhost:18090/healthz >/dev/null && break; sleep 0.5; done
curl -sf -o /dev/null localhost:18090/room-assets/drone.glb && echo "ok  assets from ConfigMap"
if [[ -z "${SKIP_BROWSER:-}" ]]; then
  (cd "$ROOT" && E2E_BASE_URL=http://127.0.0.1:18090 npx playwright test --reporter=line)
fi
kill $PF 2>/dev/null || true

step "room state survives a pod restart"
forward() {
  kubectl --kubeconfig "$KCFG" -n "$NS" port-forward svc/colo-web-colocation 18080:80 >/dev/null 2>&1 &
  PF=$!
  for _ in $(seq 1 40); do curl -sf localhost:18080/readyz >/dev/null && return; sleep 0.5; done
}
forward
node "$ROOT/test/e2e/restore-check.mjs" write ws://127.0.0.1:18080/ws
kill $PF 2>/dev/null || true
k -n "$NS" rollout restart deploy/colo-web-colocation >/dev/null
k -n "$NS" rollout status deploy/colo-web-colocation --timeout 120s >/dev/null
forward
node "$ROOT/test/e2e/restore-check.mjs" verify ws://127.0.0.1:18080/ws
kill $PF 2>/dev/null || true

if [[ -n "${CLEANUP:-}" ]]; then
  step "cleanup"
  k delete namespace "$NS" --wait=false
fi
step "kind smoke test passed"
