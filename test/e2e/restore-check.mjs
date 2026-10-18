// Restart check: `write` moves the cube in room "persist" and draws a stroke; after the pod was
// restarted, `verify` joins again and expects both to be restored from the volume.
//   node test/e2e/restore-check.mjs write  ws://127.0.0.1:18080/ws
//   node test/e2e/restore-check.mjs verify ws://127.0.0.1:18080/ws

import WebSocket from 'ws';

const [mode, url] = process.argv.slice(2);
const origin = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const ws = new WebSocket(url, { headers: { origin } });
const inbox = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
await new Promise((r, j) => {
  ws.on('open', r);
  ws.on('error', j);
});
ws.send(JSON.stringify({ t: 'hello', v: 3, room: 'persist', name: 'P', color: '#123456', device: 'desktop', space: '' }));
for (let i = 0; i < 100 && !inbox.some((m) => m.t === 'welcome'); i++) await wait(50);
const welcome = inbox.find((m) => m.t === 'welcome');
if (!welcome) throw new Error('no welcome');
const e = welcome.epoch;

if (mode === 'write') {
  ws.send(JSON.stringify({ t: 'grab', e, id: 'cube' }));
  ws.send(JSON.stringify({ t: 'release', e, id: 'cube', pose: { p: [0.123, 0.05, -0.2], q: [0, 0, 0, 1] } }));
  ws.send(JSON.stringify({ t: 'stroke', e, id: 'persist-1', board: 'wb1', color: '#000000', width: 0.004, pts: [0.2, 0.2, 0.8, 0.8] }));
  ws.send(JSON.stringify({ t: 'stroke-end', e, id: 'persist-1' }));
  await wait(3000); // the server saves changes after ~2 s
  console.log('ok  state written');
} else {
  const cube = welcome.snapshot.objects.find((o) => o.id === 'cube');
  const stroke = welcome.snapshot.strokes.find((s) => s.id === 'persist-1');
  if (cube?.pose.p[0] !== 0.123 || !stroke) {
    console.error(`FAIL: not restored (cube ${JSON.stringify(cube?.pose.p)}, stroke ${!!stroke})`);
    process.exit(1);
  }
  console.log('ok  state restored after restart');
}
ws.close();
process.exit(0);
