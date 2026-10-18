# Wire protocol (v3)

For native clients (Android XR / Jetpack XR, Unity, …) that want to join the same rooms as the
web app. The source of truth is [`shared/protocol.ts`](../shared/protocol.ts) (types),
[`shared/roomConfig.ts`](../shared/roomConfig.ts) (room configuration) and
[`shared/validate.ts`](../shared/validate.ts) (limits enforced by the server).

## Transport

- WebSocket at `wss://<host>/ws`, JSON text frames, max 64 KB per frame, ≤ 200 messages/s.
- Browsers must send an allowed `Origin`; native clients may omit it.
- With SSO the WebSocket goes through the proxy — send its session cookie.
- `GET /api/config` returns branding, the rooms the user may enter, templates and the protocol
  version (`ClientConfig` in [`shared/clientConfig.ts`](../shared/clientConfig.ts)).

## Coordinates

All poses are in the room's **shared frame**: right-handed, +Y up, meters; origin at the room
anchor (`config.anchor`). Quaternions are `[x, y, z, w]`. Unity (left-handed): negate z of
positions and send quaternions as `(-x, -y, z, w)`. Room config angles (`yaw`) are radians.

A native client keeps its own `local ← shared` transform, e.g. from the two-point calibration
(`origin = (A + B) / 2`, `+X = horizontal(B − A)`; see `frameFromTwoPoints` in
[`src/sync/sharedFrame.ts`](../src/sync/sharedFrame.ts)). Touching the same two physical points
as the web clients aligns everybody.

## Session

```
client → hello { v: 3, room, name, color: "#rrggbb", device: desktop|ar|vr, space, voice?, passcode? }
server → welcome { v, room, self: PeerInfo, epoch, config: RoomConfig, snapshot }
server → ice { iceServers, ttl }        (if voice is enabled; refreshed before ttl expires)
```

Fatal errors arrive as `error { code }` followed by close code **4003**; do not reconnect with the
same parameters: `protocol-mismatch`, `not-found`, `room-full`, `passcode-required`,
`passcode-invalid`, `forbidden`, `unauthenticated`, `rate-limited`, `too-many-rooms`.
Non-fatal: `not-allowed` (host-only action), `limit` (whiteboard full), `invalid-settings`.
Close code **1012** means the server is restarting — reconnect with backoff.

## Epochs

Messages that change room state carry `e` = the epoch from the latest `welcome`/`config`.
After `config` (room reconfigured) everything is replaced: rebuild the scene, objects, boards and
peers from the message, and use the new epoch.

## Client → server

| `t` | Fields | |
|---|---|---|
| `profile` | `device`, `space` | entering/leaving XR, same-room id |
| `voice` | `state: off\|muted\|on` | voice participation |
| `pose` | `pose: { head, hands: [left\|null, right\|null] }` | ≈20 Hz |
| `grab` | `e`, `id` | request ownership |
| `move` | `e`, `id`, `pose` | owner only, ≈30 Hz |
| `release` | `e`, `id`, `pose` | final pose |
| `stroke` | `e`, `id`, `board`, `color`, `width` (m), `pts` | start a stroke; `pts` = `[u0, v0, u1, v1, …]` in 0..1 |
| `stroke-pts` | `e`, `id`, `pts` | append (author only) |
| `stroke-end` | `e`, `id` | |
| `board-clear` | `e`, `board` | permission `clearBoard` |
| `reset-objects` | `e` | permission `resetObjects` |
| `room-settings` | `e`, `settings: { title?, template?, rules?, passcode? }` | permission `editSettings` |
| `rtc-offer` / `rtc-answer` | `to`, `sdp` | WebRTC signalling (relayed only between voice participants) |
| `rtc-ice` | `to`, `candidate` | |
| `ping` | `ts` | answered with `pong` |

Stroke ids should be unique per author (`<peer id>-<counter>`). The peer with the smaller id sends
the WebRTC offer.

## Server → client

| `t` | Fields |
|---|---|
| `welcome` / `config` | `epoch`, `config`, `self`, `snapshot: { peers, poses, objects, strokes }` |
| `peer-join` / `peer-update` / `peer-leave` | `peer` / `id` |
| `pose` | `id`, `pose` |
| `owner` | `id`, `owner` (null = released), `pose?` |
| `move` | `id`, `pose` |
| `grab-denied` | `id`, `owner`, `pose` |
| `objects` | full object list (after a reset) |
| `stroke`, `stroke-pts`, `stroke-end`, `board-clear` | as above, with the stroke's `author` |
| `ice` | `iceServers: [{ urls, username?, credential? }]`, `ttl` |
| `rtc-offer` / `rtc-answer` / `rtc-ice` | `from`, … |
| `pong` | `ts` |
| `error` | `code`, `message?` |

`PeerInfo`: `{ id, name, color, seat, device, space, voice, role: host|member, verified }`.
`ObjectState`: `{ id, kind, color, pose, scale?, model?, owner }`.
