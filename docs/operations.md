# Operations

## Endpoints

| Path | Port | |
|---|---|---|
| `/healthz` | main + `HEALTH_PORT` | liveness — the process is up |
| `/readyz` | main + `HEALTH_PORT` | readiness — `503` while shutting down |
| `/metrics` | main + `HEALTH_PORT` | Prometheus text format |
| `/api/config` | main | lobby/branding data for the browser |
| `/ws` | main | WebSocket sync |
| `/room-assets/*` | main | files from `assets.dir` |

The health port never reads identity headers, so it is safe to expose to the kubelet and to
load balancer health checks. With oauth2-proxy in front, load balancers should check `/ping`
on the proxy port instead.

## Metrics

| Metric | Type | |
|---|---|---|
| `colo_rooms` | gauge | rooms in memory |
| `colo_participants` | gauge | connected participants |
| `colo_ws_open_connections` | gauge | open WebSockets |
| `colo_ws_connections_total` | counter | accepted WebSocket connections |
| `colo_ws_rejected_total{reason}` | counter | upgrades refused (`origin`, `unauthenticated`) |
| `colo_join_errors_total{code}` | counter | failed joins (`room-full`, `passcode-invalid`, `forbidden`, …) |

## Logs

One JSON object per line on stdout/stderr (`LOG_FORMAT=pretty` for humans): `room created`,
`peer joined` (room, peer, device, seat, role), `peer left`, `room settings changed`,
`configuration reloaded`, errors. Display names, emails and passcodes are not logged.

## State and backups

With `storage.driver: file`, `storage.dir` contains `rooms/<hash>.json` — one document per room
(settled object poses, finished drawings, host settings), written atomically after changes and on
shutdown. Back it up like any small volume (volume snapshots, or copy the directory). To reset a
room, delete its file while the room is empty (or restart after deleting). Stored ad-hoc rooms
unused for `rooms.adhocTtlHours` are removed automatically.

## Configuration changes

The app watches its config file. Valid changes apply live; invalid ones are logged and ignored
(the previous configuration stays active), so a typo never takes the service down. With Helm,
`helm upgrade` only updates the ConfigMap — no pod restart.

## Upgrades and restarts

The pod is replaced (strategy `Recreate`): readiness turns off, `preStop` lets the load balancer
drain, sockets close with 1012, state is written, and the new pod restores it. Participants see a
short reconnect. Schedule upgrades outside meetings if possible.

## Capacity

One pod (single Node.js process) handles all rooms. Each participant sends ~20 pose updates per
second while connected; moves and drawing add bursts. Measured with `scripts/loadtest.ts` on a
laptop (Apple M-series, Node 26) — see the numbers below and size your resources accordingly.

<!-- capacity-table -->

Voice audio is peer to peer (or via TURN) and does not pass through this server.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md).
