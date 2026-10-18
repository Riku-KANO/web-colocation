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
| `colo_event_loop_lag_p99_ms` | gauge | event-loop lag since the previous scrape (alert if it stays above ~50 ms) |
| `process_cpu_seconds_total`, `process_resident_memory_bytes` | gauge | process CPU time and memory |

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

One pod (a single Node.js process) handles all rooms. Each participant sends ~20 pose updates per
second; one person per room moving an object adds 30 updates per second.

Measured with [`scripts/loadtest.ts`](../scripts/loadtest.ts) — rooms of 8 people, everyone
streaming poses, one object moving continuously in every room. Apple M5 Pro, Node 26, load
generator on the same machine (so the server shared the CPU), 15 s per run:

| Participants | Messages in / out per s | Server CPU (one core) | Memory (RSS) | Event-loop lag p99 | Move delivery p50 / p99 |
|---:|---:|---:|---:|---:|---:|
| 40 (5 rooms) | 0.9k / 6.6k | 10 % | 119 MB | 1.7 ms | 0.6 / 2.1 ms |
| 160 (20 rooms) | 3.8k / 26k | 22 % | 119 MB | 3.8 ms | 0.9 / 6.0 ms |
| 400 (50 rooms) | 9.4k / 66k | 34 % | 157 MB | 7.1 ms | 1.4 / 10.3 ms |
| 800 (100 rooms) | 19k / 131k | 49 % | 165 MB | 6.1 ms | 2.3 / 10.8 ms |

Guidance: the chart's defaults (100m CPU request, 512 MiB memory limit) suit small teams; for a few
hundred concurrent participants request about one CPU core. Network bandwidth grows with
participants × room size (each pose is ~250 bytes, fanned out to everyone else in the room).
Server-side delay is a few milliseconds; what users feel is dominated by their network.

Run it against your own deployment:

```bash
node scripts/loadtest.ts --url wss://xr.acme.example/ws --metrics http://<pod-ip>:8081/metrics --rooms 20 --per-room 8
```

Voice audio is peer to peer (or via TURN) and does not pass through this server.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md).
