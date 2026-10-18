# web-colocation

**WebXR meeting rooms you can run on your own infrastructure.** People join from Meta Quest,
Android XR, Apple Vision Pro or an ordinary browser, sit around a shared table, move objects,
write on whiteboards with pens, and talk with spatial voice. Everyone in the same physical room
can align their headsets so virtual objects sit on the real table.

[日本語の README はこちら](README.ja.md)

- **Shared space** — objects, pens and whiteboards stay in sync; first grab wins, others see it move.
- **Colocation** — remote people place the room on their own desk; people in the same room
  calibrate with two touches so everyone's virtual table matches the real one.
- **Customizable rooms** — tables, seats, boards, your own glTF models, environment and rules,
  defined in YAML templates or changed by hosts in the app.
- **Company ready** — SSO through oauth2-proxy (Google Workspace, Entra ID, Okta, any OIDC),
  host/member roles, allow lists, passcodes, TURN with short-lived credentials, persistence.
- **Easy to install** — one container, one Helm chart, examples for EKS (ALB), GKE and
  Gateway API; config changes apply live.

> Status: v0.2 (pre-release). Tested with the WebXR emulator and kind; please report results
> from real headsets and clouds.

## Try it locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 in two browser tabs, enter the same room and drag things around.
Add `&emulate=quest3` to the URL to try the XR mode without a headset.

With Docker:

```bash
docker compose up --build        # http://localhost:8080 with sample rooms and a 3D model
```

SSO demo (dex + oauth2-proxy, user `alice@example.com` / `password`):

```bash
docker compose -f compose.yaml -f deploy/compose/sso.compose.yaml up --build   # http://localhost:4180
```

## Install on Kubernetes

```bash
helm install colo oci://ghcr.io/OWNER/charts/web-colocation \
  -n xr --create-namespace -f my-values.yaml
```

Start from an example in [`deploy/examples/`](deploy/examples): `eks-alb.yaml`,
`gke-ingress.yaml`, `gateway-api.yaml`, `oauth2-proxy-google.yaml`, `oauth2-proxy-entra.yaml`.
Headsets require **HTTPS**. See [docs/deploy-kubernetes.md](docs/deploy-kubernetes.md).

```yaml
# my-values.yaml (excerpt)
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

## Use it in a headset

1. Open the site (HTTPS) in the headset browser, pick a room and press **Enter AR** (or VR).
2. The room appears in front of you. Use the wrist panel (left hand) to
   - **Place here (1 pt)** — touch the centre of your real table to put the room on it, or
   - **Same room (2 pts)** — everyone in the same physical room touches the same two points
     (e.g. the middle of both short edges of a table) in the same order.
3. Grab objects with the trigger / pinch. Hold a pen and touch a board to write.

On a PC: drag objects, Shift+drag to lift, mouse wheel while dragging to rotate, drag on a board to draw.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | local development, headsets over HTTPS, emulator |
| [Configuration](docs/configuration.md) · [reference](docs/configuration-reference.md) | the config file and every option |
| [Room templates](docs/room-templates.md) | layouts, furniture, boards, custom 3D models, rules |
| [Deploy on Kubernetes](docs/deploy-kubernetes.md) | Helm chart, EKS / GKE / Gateway API, TLS |
| [Authentication](docs/auth.md) | SSO with oauth2-proxy, hosts, allow lists, passcodes |
| [Voice and TURN](docs/turn.md) | when you need TURN and how to run it |
| [Operations](docs/operations.md) | health, metrics, logs, backups, upgrades, capacity |
| [Architecture](docs/architecture.md) · [Protocol](docs/protocol.md) | how it works, for contributors and native clients |
| [Troubleshooting](docs/troubleshooting.md) · [Roadmap](docs/roadmap.md) | |

## Platform support

| | AR (passthrough) | VR | Hands | Anchors |
|---|---|---|---|---|
| Meta Quest Browser | ✓ | ✓ | ✓ | ✓ |
| Chrome on Android XR | ✓ | ✓ | ✓ | ✓ |
| Safari on Apple Vision Pro | – | ✓ | gaze + pinch | – |
| Desktop / mobile browsers | – | – | mouse / touch | – |

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues: please follow [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
