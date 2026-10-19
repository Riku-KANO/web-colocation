# Configuration

The server reads one YAML (or JSON) file given by `COLO_CONFIG`. With the Helm chart you put the
same content under `config:` in your values. Every option is listed in the
[configuration reference](configuration-reference.md); this page explains how they fit together.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/OWNER/web-colocation/main/schema/config.schema.json
branding:
  productName: { en: Acme XR Rooms, ja: Acme XR ルーム }
  logo: /room-assets/logo.svg
  accentColor: "#0a7cff"
rooms:
  allowAdhoc: true
  list:
    - id: design-review
      title: { en: Design review, ja: デザインレビュー }
      template: workshop
```

- **Validation**: an invalid file stops the server with the exact path of the problem
  (`rooms.list[0].template: unknown template "worksop"`). With Helm, `helm install` already
  rejects invalid `config:` values because the chart embeds the same schema.
- **Live reload**: the directory of the file is watched (this also works for Kubernetes
  ConfigMaps). New room definitions, templates, branding and access lists apply without a
  restart: running rooms are re-laid out if their template changed, and people who lost access
  are removed. Changes to `storage` need a restart.
- **Empty sections** (`voice:` with everything commented out) mean "use the defaults".
- **Units**: meters and degrees.

## Environment variables

| Variable | Default | |
|---|---|---|
| `COLO_CONFIG` | – | path of the config file |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | main listener (app, `/api`, `/ws`) |
| `HEALTH_PORT` | – | separate listener for `/healthz`, `/readyz`, `/metrics` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | `debug`…`error`; `pretty` for humans |
| `COLO_STATIC_DIR` | `dist` | built web app |
| `TLS_CERT` / `TLS_KEY` | – | serve HTTPS directly (usually TLS ends at the load balancer) |
| `COLO_PUBLIC_URL`, `COLO_AUTH_MODE`, `COLO_STORAGE_DRIVER`, `COLO_STORAGE_DIR`, `COLO_ASSETS_DIR`, `COLO_DEFAULT_LANGUAGE` | – | override the matching config options (handy for `docker run`) |
| `TURN_SECRET` (or `voice.turn.secretEnv`) | – | TURN REST shared secret |

## Sections

### Rooms

Three layers decide what a room looks like:

1. **Templates** — layouts (tables, seats, boards, objects, environment, rules). Four are built
   in (`standard`, `round-table`, `workshop`, `presentation`); add your own under `templates:`.
   See [room templates](room-templates.md).
2. **Room definitions** (`rooms.list`) — a room id, title, template, overrides, hosts, access
   list and passcode. These are listed in the lobby (unless `unlisted: true`).
3. **Host settings** — hosts can change the title, template, rules and passcode in the app
   ("Room settings"). These are stored with the room state and survive restarts. Access lists,
   hosts and a passcode set in the config file always win over in-app changes.

`rooms.allowAdhoc: true` lets people create rooms by typing any name in the lobby; they use
`rooms.adhocTemplate`, and their stored state is deleted after `rooms.adhocTtlHours` without use.
In ad-hoc rooms (and configured rooms without `hosts`) the first person to join is the host;
the role passes on when they leave.

### Rules and permissions

```yaml
rules:
  maxParticipants: 8          # also limited by the number of seats
  voice: { enabled: true }
  permissions:
    clearBoard: hosts         # everyone | hosts
    resetObjects: everyone
    editSettings: hosts
```

Rules can be set in a template, overridden per room (`rooms.list[].overrides.rules`) and
changed by hosts in the app. The server enforces them; the UI greys out what you cannot do.

### Passcodes

Generate a hash and put it in the room definition:

```bash
npm run hash-passcode            # asks for the passcode without echoing it
# or with Docker:
docker run --rm -it ghcr.io/OWNER/web-colocation node scripts/hash-passcode.ts
```

```yaml
rooms:
  list:
    - id: board-meeting
      passcodeHash: "scrypt$16384$8$1$...$..."
```

Repeated wrong passcodes are rate limited. Configured hosts and admins skip the passcode.

### Branding

`productName`, `logo`, `accentColor` and `lobbyMessage` appear in the lobby and the app. Text
can be a plain string or a map per language (`{ en: ..., ja: ... }`). Serve your logo from the
assets directory (`/room-assets/logo.svg`) or any https URL.

### Assets and 3D models

`assets.dir` is served at `/room-assets/`. Put logos and glTF/GLB models there (with Helm, mount
a PVC or ConfigMap — see [deploy-kubernetes.md](deploy-kubernetes.md#assets)). Models may also
come from https origins listed in `assets.allowedOrigins`. Browsers refuse models larger than
`assets.maxModelBytes`, with more than 500k triangles or textures above 4096 px.

### Authentication

`auth.mode: trusted-headers` makes the app trust identity headers from an authenticating
proxy (oauth2-proxy by default). See [auth.md](auth.md).

### Voice

Voice is peer to peer (WebRTC). STUN is enough on many networks; corporate networks usually
need TURN — see [turn.md](turn.md).

```yaml
voice:
  turn:
    urls: ["turn:turn.acme.example:3478?transport=udp", "turns:turn.acme.example:443?transport=tcp"]
    secretEnv: TURN_SECRET
```

### Storage

`storage.driver: file` keeps room state (object positions, drawings, host settings) in
`storage.dir`, one JSON file per room, written atomically. `memory` keeps nothing across
restarts. The Helm chart sets this from `persistence.enabled`.

### XR controller models in closed networks

Controller and hand models are downloaded from jsDelivr by default. Self-host the
[`@webxr-input-profiles/assets`](https://www.npmjs.com/package/@webxr-input-profiles/assets)
`dist/profiles` directory and set `xr.inputProfilesPath` to its URL, or set it to `none` to
use simple built-in shapes.

### Security headers

`server.csp` controls the Content-Security-Policy of the app page and is `enforce` by default.
`report-only` logs violations in the browser console without blocking, which helps when adding
model or logo origins. The page also sends `X-Frame-Options: SAMEORIGIN`. `server.publicUrl` and
`server.allowedOrigins` decide which pages may open WebSockets (same-host pages always can).
