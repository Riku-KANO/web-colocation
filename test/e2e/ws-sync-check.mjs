// Two WebSocket clients join the same room; a move made by one must reach the other.
//   node test/e2e/ws-sync-check.mjs ws://localhost:8080/ws

import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://localhost:8080/ws';
const origin = url.replace(/^ws/, 'http').replace(/\/ws$/, '');

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin } });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: 3, room: 'smoke', name, color: '#123456', device: 'desktop', space: '' }));
      const wait = setInterval(() => {
        const w = inbox.find((m) => m.t === 'welcome');
        if (w) {
          clearInterval(wait);
          resolve({ ws, inbox, welcome: w });
        }
      }, 20);
    });
    ws.on('error', reject);
  });
}

const a = await client('A');
const b = await client('B');
const e = a.welcome.epoch;
a.ws.send(JSON.stringify({ t: 'grab', e, id: 'cube' }));
a.ws.send(JSON.stringify({ t: 'move', e, id: 'cube', pose: { p: [0.1, 0.2, 0.3], q: [0, 0, 0, 1] } }));
const deadline = Date.now() + 3000;
let mv;
while (!(mv = b.inbox.find((m) => m.t === 'move')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
a.ws.close();
b.ws.close();
if (!mv) {
  console.error(`FAIL: no move received; got ${b.inbox.map((m) => m.t).join(',')}`);
  process.exit(1);
}
console.log(`ok  WebSocket sync (move ${JSON.stringify(mv.pose.p)})`);
