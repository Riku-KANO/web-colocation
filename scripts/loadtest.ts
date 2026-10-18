// Load test: N rooms × M simulated participants against a running server.
//
//   PORT=8090 HEALTH_PORT=8091 COLO_CONFIG=<config with rooms.adhocTemplate: workshop> node server/main.ts
//   node scripts/loadtest.ts --url ws://127.0.0.1:8090/ws --metrics http://127.0.0.1:8091/metrics \
//        --rooms 20 --per-room 8 --seconds 20
//
// Every participant sends its head/hand pose at 20 Hz (like a headset). One participant per room
// holds an object and moves it at 30 Hz; the others measure how long each move takes to arrive.
// The server's CPU, memory and event-loop delay are read from /metrics.

import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMsg } from '../shared/protocol.ts';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:8090/ws' },
    metrics: { type: 'string', default: 'http://127.0.0.1:8091/metrics' },
    rooms: { type: 'string', default: '10' },
    'per-room': { type: 'string', default: '8' },
    seconds: { type: 'string', default: '20' },
  },
});
const ROOMS = Number(args.rooms);
const PER_ROOM = Number(args['per-room']);
const SECONDS = Number(args.seconds);
const origin = args.url!.replace(/^ws/, 'http').replace(/\/ws$/, '');

const latencies: number[] = [];
let received = 0;
let sent = 0;
let failures = 0;
const sockets: WebSocket[] = [];

const stamp = () => (performance.now() % 100_000) / 1000; // fits the coordinate limits
const pose = (x: number) => ({ p: [x, 0.5, 0.8] as [number, number, number], q: [0, 0.1, 0, 0.995] as [number, number, number, number] });

async function metrics(): Promise<Record<string, number>> {
  const text = await (await fetch(args.metrics!)).text();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z0-9_]+) ([0-9.eE+-]+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function participant(room: number, index: number): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(args.url!, { headers: { origin } });
    sockets.push(ws);
    let epoch = 1;
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: `load-${room}`, name: `L${room}-${index}`, color: '#336699', device: 'vr', space: '' }));
    });
    ws.on('message', (data) => {
      received++;
      const m = JSON.parse(data.toString()) as ServerMsg;
      if (m.t === 'welcome') {
        epoch = m.epoch;
        resolve();
      } else if (m.t === 'move' && index !== 0) {
        let d = (performance.now() % 100_000) - m.pose.p[0] * 1000;
        if (d < 0) d += 100_000;
        latencies.push(d);
      } else if (m.t === 'error') {
        failures++;
        resolve();
      }
    });
    ws.on('close', () => failures++);
    ws.on('error', () => resolve());
    const send = (msg: unknown) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
        sent++;
      }
    };
    // Pose stream (offset so clients do not all send in the same tick).
    setTimeout(() => {
      setInterval(() => send({ t: 'pose', pose: { head: pose(index * 0.1), hands: [pose(0.2), pose(-0.2)] } }), 50);
    }, Math.random() * 50);
    if (index === 0) {
      setTimeout(() => {
        send({ t: 'grab', e: epoch, id: 'cube' });
        setInterval(() => send({ t: 'move', e: epoch, id: 'cube', pose: { p: [stamp(), 0.05, 0], q: [0, 0, 0, 1] } }), 33);
      }, 500);
    }
  });
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);

const clients = ROOMS * PER_ROOM;
console.log(`connecting ${clients} participants (${ROOMS} rooms × ${PER_ROOM})…`);
const joins: Promise<void>[] = [];
for (let r = 0; r < ROOMS; r++) for (let i = 0; i < PER_ROOM; i++) joins.push(participant(r, i));
await Promise.all(joins);
await new Promise((r) => setTimeout(r, 2000)); // warm up
latencies.length = 0;
received = 0;
sent = 0;
const m0 = await metrics();
const t0 = performance.now();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const m1 = await metrics();
const elapsed = (performance.now() - t0) / 1000;
for (const ws of sockets) ws.terminate();

const sorted = latencies.sort((a, b) => a - b);
const result = {
  participants: clients,
  rooms: ROOMS,
  'msgs in/s': Math.round(sent / elapsed),
  'msgs out/s': Math.round(received / elapsed),
  'server CPU %': Math.round(((m1.process_cpu_seconds_total - m0.process_cpu_seconds_total) / elapsed) * 1000) / 10,
  'server RSS MB': Math.round(m1.process_resident_memory_bytes / 1e6),
  'event loop lag p99 ms': m1.colo_event_loop_lag_p99_ms,
  'move latency p50 ms': Math.round(pct(sorted, 50) * 10) / 10,
  'move latency p99 ms': Math.round(pct(sorted, 99) * 10) / 10,
  failures,
};
console.log(JSON.stringify(result));
process.exit(0);
