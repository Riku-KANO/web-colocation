# Architecture

```
 Browser / headset (three.js + WebXR)                  Server (Node.js, one process)
 ┌──────────────────────────────────────────┐          ┌───────────────────────────────────┐
 │ WebXR reference space (local-floor)       │  HTTPS   │ HTTP: /api/config, /room-assets,  │
 │  └─ sharedRoot  (matrix M = local←shared) │◀────────▶│       health, metrics, static     │
 │      ├─ tables, boards (from RoomConfig)  │          │ RoomRegistry: config, templates,  │
 │      ├─ shared objects  (ObjectManager)   │   WSS    │   access, passcodes, persistence  │
 │      └─ remote avatars  (AvatarManager)   │◀────────▶│ Room: peers, objects, strokes,    │
 │ Voice: WebRTC mesh (peer to peer / TURN)  │          │   ownership, epochs, permissions  │
 └──────────────────────────────────────────┘          └───────────────────────────────────┘
```

**Only shared-frame values travel over the network.** Each device computes its own
`M = local ← shared` and places all shared content under `sharedRoot`; outgoing poses are
converted with `M⁻¹`.

## Shared frame and calibration

The shared frame is right-handed, +Y up, in meters; its origin is the room anchor (the main table
top centre, or a floor point for `anchor.kind: floor`). [`src/sync/sharedFrame.ts`](../src/sync/sharedFrame.ts):

| Mode | Input | How M is chosen | Use |
|---|---|---|---|
| auto | head pose when entering XR | puts you at your seat, facing the seat's direction; table at a comfortable height | instant start |
| one point | touch your table centre | origin at the touched point; rotation from the direction to your head vs. your seat | remote participants |
| two points | everyone touches the same A, B | origin = midpoint, +X = A→B | people in the same physical room |
| desktop | – | origin `floorOffset` above the local floor | PC / mobile |

WebXR has no standard shared or cloud anchors (Meta's experimental "shared" space is Quest-only),
so manual calibration is the one method that works in every browser. After calibrating, an
`XRAnchor` (where supported) keeps the frame aligned when the device's tracking relocalizes.

## Synchronization

### Objects — ownership

1. On grab, the client starts moving the object locally (optimistic) and sends `grab`.
2. The server grants the first claimant and broadcasts `owner`.
3. A losing claimant gets `owner`/`grab-denied` with the authoritative pose and lets go.
4. Only the owner may send `move` (≈30 Hz); `release` carries the final pose.
5. Objects held by someone who disconnects are released where they are.

Non-owners follow received poses with frame-rate independent exponential smoothing.

### Avatars

Head and both hands at 20 Hz; the server keeps the latest pose for late joiners. In XR, people
who share a "Same-room ID" see only name tags for each other (they see the real person).

### Whiteboards

Strokes use normalized board coordinates (u, v), so boards can differ in size between devices.
`stroke` → `stroke-pts` (batched every 40 ms) → `stroke-end`. Each device rasterizes into a
`CanvasTexture`; uploads are limited to 30 Hz. The server enforces per-stroke and per-room point
budgets.

### Epochs

When a host changes the room settings, the server atomically releases held objects, resets
objects, drops strokes on removed boards, reassigns seats, increments the **epoch** and sends
everyone a `config` message with a full snapshot. State-changing messages carry the epoch they
were made in; stale ones are dropped (e.g. a `grab` sent just before the layout changed).

### Late join and reconnect

`welcome` contains the room config and a full snapshot. Clients reconnect automatically with a
new peer id and rebuild from the snapshot; fatal errors (wrong passcode, room full, …) stop the
reconnect loop.

## Server

| Module | |
|---|---|
| [`server/config/`](../server/config) | zod schema, YAML loading, template resolution, live reload |
| [`server/rooms.ts`](../server/rooms.ts) | room lifecycle, access checks, passcodes, host settings, persistence, TURN credentials |
| [`server/room.ts`](../server/room.ts) | one room's state; the only place it changes (transport-agnostic) |
| [`server/colocationServer.ts`](../server/colocationServer.ts) | WebSocket upgrade (Origin check, identity), rate limits, heartbeats |
| [`server/http/`](../server/http) | `/api/config`, health, metrics, static files, CSP |
| [`server/fileStore.ts`](../server/fileStore.ts) | atomic JSON files per room |

The same app runs inside the Vite dev server (`server/vitePlugin.ts`), in production
(`server/main.ts`) and in tests.

### Security measures

- Input validation for every message (`shared/validate.ts`), 64 KB frames, 200 messages/s per
  connection, buffered-output cap.
- WebSocket Origin check (CSWSH), trusted identity headers only on a loopback listener.
- Passcodes as scrypt hashes with rate limiting; secrets and access lists never reach clients.
- `/room-assets` resolves real paths (no symlink escapes); SVGs are sandboxed.
- Content-Security-Policy generated from the config; glTF size/triangle/texture limits.
- TURN credentials are short-lived and issued only to participants.

## Client

| Module | |
|---|---|
| [`src/app.ts`](../src/app.ts) | scene, network bridge, XR session, calibration state machine |
| [`src/scene/`](../src/scene) | environment and furniture from the RoomConfig, object meshes, glTF loader |
| [`src/sync/`](../src/sync) | shared frame, object ownership sync, avatars |
| [`src/board/`](../src/board) | whiteboards and stroke batching |
| [`src/input/`](../src/input) | XR controllers/hands and desktop mouse/touch |
| [`src/voice/`](../src/voice) | WebRTC mesh, microphone, spatial audio, speaking detection |
| [`src/ui/`](../src/ui) | lobby, HUD, settings dialog, XR wrist panel |
| [`src/i18n/`](../src/i18n) | typed dictionaries (en, ja) |

## Scaling beyond one process

Rooms are in memory, so v0.2 runs a single replica. The planned path is a Redis backplane: any pod
accepts connections, room state and ownership decisions live in Redis (or a pod leases each
room), and messages fan out over pub/sub. Consistent hashing on the room id at the load balancer
is an alternative where supported (Envoy Gateway `ConsistentHash` on a query parameter).
