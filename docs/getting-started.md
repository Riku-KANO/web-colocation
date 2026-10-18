# Getting started

## Requirements

- Node.js **23.6 or newer** (the server runs TypeScript directly; developed with Node 26)
- For containers: Docker; for Kubernetes: Helm 3.15+ or Helm 4

## Run the development server

```bash
npm install
npm run dev            # http://localhost:5173 — app, API and WebSocket on one port
npm run dev:example    # same, with examples/config.yaml (branding, rooms, a 3D model)
```

Open the page in two tabs, join the same room, and move objects or draw on a board.
URL parameters skip the lobby: `?room=demo&name=Alice&autojoin=1`. Add `&lang=ja` or
`&lang=en` to switch the language.

| PC controls | |
|---|---|
| Drag an object | move it horizontally |
| Shift + drag | move it up/down |
| Mouse wheel (while dragging) or Q / E | rotate |
| Drag on a board | draw (pick the ink colour at the bottom) |
| Drag elsewhere / wheel | orbit / zoom the view |

## Try XR without a headset

Append `&emulate=quest3` and press **Enter AR**. Meta's
[Immersive Web Emulation Runtime](https://github.com/meta-quest/immersive-web-emulation-runtime)
provides a simulated Quest 3. Controllers can be scripted from the console:

```js
const r = __xrDevice.controllers.right;
r.position.set(0.3, 0.8, -1.1);
r.updateButtonValue('trigger', 1);   // grab / press
```

`window.__colo.debugState()` summarizes the client state (useful in tests).

## Open it in a headset

WebXR only works on secure pages. Pick one:

**A. HTTPS on your LAN (self-signed certificate)**

```bash
npm run dev:https      # prints https://<your-ip>:5173 — accept the certificate warning in the headset
```

**B. USB + `localhost`** (Quest and Android XR)

```bash
adb reverse tcp:5173 tcp:5173      # then open http://localhost:5173 in the headset browser
```

Chrome on Android XR asks for the "3D mapping / camera tracking" permission the first time.
Remote debugging: `chrome://inspect/#devices` on your PC.

### In XR

| Action | |
|---|---|
| Trigger / grip / pinch | grab the nearest object, or the one the ray points at |
| Grab a pen | the pen attaches to the ray; touch a board with its tip to write |
| Trigger on a board (empty hand) | draw with the ray |
| Wrist panel (left hand, press with the right ray) | place the room, same-room calibration, reset, clear, voice, exit |

**Placing the room**

- *Place here (1 pt)*: touch the centre of your real table and pull the trigger — the virtual
  table goes there and you sit at your assigned seat. Use this when everyone is in a different place.
- *Same room (2 pts)*: everybody in the same physical room touches the **same two points in the
  same order** (e.g. the middle of the left and right short edges of a table). The further
  apart the points, the better the alignment. Enter the same "Same-room ID" in the lobby so
  people in the room see each other's name tags instead of avatars.
- *Place in front*: put the room in front of you again.

## Run with Docker

```bash
docker compose up --build                       # http://localhost:8080
docker compose --profile turn up --build        # adds a local coturn TURN server
docker compose -f compose.yaml -f deploy/compose/sso.compose.yaml up --build   # SSO demo on :4180
```

The compose setup mounts [`deploy/compose/config.yaml`](../deploy/compose/config.yaml); edit it
and the running server picks up the change.

## Run the production build without containers

```bash
npm run build
COLO_CONFIG=examples/config.yaml PORT=8080 HEALTH_PORT=8081 npm start
```

## Tests

```bash
npm test                    # unit + integration tests (server, protocol, config, XR math)
npm run typecheck
npm run test:e2e            # browser end-to-end tests (Playwright + XR emulator)
scripts/kind-smoke.sh       # container + Helm chart on a local kind cluster, including SSO
```

Next: [configure rooms and branding](configuration.md) or [deploy on Kubernetes](deploy-kubernetes.md).
