// Regenerates the README screenshots in docs/images/ with a headless browser.
//
//   npm run build && node scripts/screenshots.ts
//
// Starts the production server with examples/config.yaml, fills rooms with scripted
// participants (avatars, whiteboard sketches, an object being held) and captures the scenes.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Quat, type ServerMsg } from '../shared/protocol.ts';
import type { RoomConfig, SeatSpec } from '../shared/roomConfig.ts';

const PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL('../docs/images/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ONLY=hero,xr limits the run to some scenes (handy while tuning one). */
const only = process.env.ONLY?.split(',');
const want = (scene: string) => !only || only.includes(scene);

// ---- server ----

const server = spawn('node', ['server/main.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COLO_CONFIG: 'examples/config.yaml', LOG_LEVEL: 'warn' },
  stdio: 'inherit',
});
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/readyz`)).ok) break;
  } catch {
    // not up yet
  }
  await wait(250);
}

// ---- scripted participants ----

type V3 = [number, number, number];
const yawQ = (yaw: number, pitch = 0): Quat => {
  // q = qYaw * qPitch (turn, then look down)
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
};

class Bot {
  readonly ws: WebSocket;
  config!: RoomConfig;
  epoch = 1;
  seat!: SeatSpec;
  private counter = 0;
  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async join(room: string, name: string, color: string): Promise<Bot> {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { origin: BASE } });
    const bot = new Bot(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room, name, color, device: 'vr', space: '' })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as ServerMsg;
        if (m.t === 'welcome') {
          bot.config = m.config;
          bot.epoch = m.epoch;
          bot.seat = m.config.seats[m.self.seat];
          resolve();
        }
        if (m.t === 'error') reject(new Error(m.code));
      });
      ws.on('error', reject);
    });
    return bot;
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Sit on the seat, look slightly down at the table, hands resting in front. */
  sit(lean = 0.08, handHeight = 0.04) {
    const { x, z, yaw } = this.seat;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx; // right of the seat
    const eye = 1.2 - this.config.anchor.floorOffset;
    const head: V3 = [x + fx * lean, eye, z + fz * lean];
    const hand = (side: number): V3 => [x + fx * 0.32 + rx * 0.16 * side, handHeight, z + fz * 0.32 + rz * 0.16 * side];
    const q = yawQ(yaw, -0.35);
    this.send({ t: 'pose', pose: { head: { p: head, q }, hands: [{ p: hand(-1), q: yawQ(yaw) }, { p: hand(1), q: yawQ(yaw) }] } });
  }

  /** Hold an object up in front of the seat. */
  hold(id: string, height = 0.22) {
    const { x, z, yaw } = this.seat;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    this.send({ t: 'grab', e: this.epoch, id });
    this.send({ t: 'move', e: this.epoch, id, pose: { p: [x + fx * 0.45, height, z + fz * 0.45], q: yawQ(yaw + 0.6) } });
  }

  stroke(board: string, color: string, pts: number[], width = 0.006) {
    const id = `${this.ws.url.length}-${++this.counter}-${Math.random().toString(36).slice(2, 6)}`;
    this.send({ t: 'stroke', e: this.epoch, id, board, color, width, pts: pts.slice(0, 2) });
    for (let i = 2; i < pts.length; i += 400) this.send({ t: 'stroke-pts', e: this.epoch, id, pts: pts.slice(i, i + 400) });
    this.send({ t: 'stroke-end', e: this.epoch, id });
  }

  close() {
    this.ws.close();
  }
}

/** Join people in order; `null` entries take a seat temporarily so later people sit further on. */
async function seat(room: string, people: Array<[string, string] | null>): Promise<Bot[]> {
  const joined: Array<Bot | null> = [];
  for (const p of people) joined.push(await Bot.join(room, p ? p[0] : 'placeholder', p ? p[1] : '#888888'));
  const bots: Bot[] = [];
  joined.forEach((b, i) => (people[i] ? bots.push(b!) : b!.close()));
  await wait(200);
  for (const b of bots) b.sit();
  return bots;
}

// Whiteboard sketch helpers (normalized board coordinates, origin bottom-left).
const line = (u0: number, v0: number, u1: number, v1: number, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => [u0 + ((u1 - u0) * i) / n, v0 + ((v1 - v0) * i) / n]).flat();
const rect = (u0: number, v0: number, u1: number, v1: number) => [...line(u0, v0, u1, v0), ...line(u1, v0, u1, v1), ...line(u1, v1, u0, v1), ...line(u0, v1, u0, v0)];
const circle = (cu: number, cv: number, r: number, aspect = 1.5, n = 48) =>
  Array.from({ length: n + 1 }, (_, i) => [cu + (r / aspect) * Math.cos((i / n) * Math.PI * 2), cv + r * Math.sin((i / n) * Math.PI * 2)]).flat();
const handwriting = (u0: number, v: number, width: number, seed = 1) =>
  Array.from({ length: 60 }, (_, i) => [u0 + (width * i) / 59, v + 0.018 * Math.sin(i * 1.7 + seed) + 0.008 * Math.sin(i * 4.1 + seed * 2)]).flat();
const arrow = (u0: number, v: number, u1: number) => [...line(u0, v, u1, v), ...line(u1 - 0.025, v + 0.03, u1, v, 3), ...line(u1, v, u1 - 0.025, v - 0.03, 3)];
const check = (u: number, v: number, s = 0.04) => [...line(u, v, u + s * 0.4, v - s, 4), ...line(u + s * 0.4, v - s, u + s * 1.3, v + s * 0.9, 6)];

async function sketchRoadmap(bot: Bot, board: string) {
  bot.stroke(board, '#1d4ed8', rect(0.06, 0.55, 0.3, 0.8));
  bot.stroke(board, '#1d4ed8', rect(0.38, 0.55, 0.62, 0.8));
  bot.stroke(board, '#1d4ed8', rect(0.7, 0.55, 0.94, 0.8));
  bot.stroke(board, '#222222', arrow(0.31, 0.675, 0.37));
  bot.stroke(board, '#222222', arrow(0.63, 0.675, 0.69));
  bot.stroke(board, '#222222', handwriting(0.09, 0.69, 0.17, 1), 0.004);
  bot.stroke(board, '#222222', handwriting(0.41, 0.69, 0.17, 2), 0.004);
  bot.stroke(board, '#222222', handwriting(0.73, 0.69, 0.17, 3), 0.004);
  bot.stroke(board, '#15803d', check(0.12, 0.62));
  bot.stroke(board, '#d62828', circle(0.82, 0.3, 0.13));
  bot.stroke(board, '#222222', handwriting(0.1, 0.36, 0.45, 4), 0.004);
  bot.stroke(board, '#222222', handwriting(0.1, 0.24, 0.35, 5), 0.004);
  bot.stroke(board, '#d62828', line(0.1, 0.17, 0.48, 0.17));
}

// ---- browser ----

const browser = await chromium.launch();
async function newPage(scale = 2, height = 800): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  return page;
}

async function joinPage(page: Page, room: string, name: string, extra = '') {
  await page.goto(`${BASE}/?room=${room}&name=${name}&color=%23e4572e&autojoin=1&lang=en${extra}`);
  await page.waitForFunction(() => !!(window as unknown as { __colo: { room: unknown } }).__colo?.room);
}

/** Place the desktop camera (shared-frame coordinates). */
async function camera(page: Page, eye: V3, target: V3, fov = 50) {
  await page.evaluate(
    ({ eye, target, fov }) => {
      const app = (window as unknown as { __colo: any }).__colo; // eslint-disable-line @typescript-eslint/no-explicit-any
      const V = app.camera.position.constructor;
      const e = app.frame.root.localToWorld(new V(...eye));
      const t = app.frame.root.localToWorld(new V(...target));
      app.camera.fov = fov;
      app.camera.updateProjectionMatrix();
      app.camera.position.copy(e);
      app.desktop.controls.target.copy(t);
      app.camera.lookAt(t);
      app.desktop.controls.update();
    },
    { eye, target, fov },
  );
}

const hideBottomBar = (page: Page) => page.addStyleTag({ content: '#hud .bottom { display: none !important; }' });
const hideToasts = (page: Page) => page.addStyleTag({ content: '#hud .toast { display: none !important; }' });
const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);

// 1. Hero: product demo around a round table, with a drone model and a sketch on the board.
if (want('hero')) {
  const page = await newPage();
  await joinPage(page, 'design-review', 'You');
  await hideToasts(page);
  // seats on a circle: 1 front-right, 2 back-right, 3 in front of the board (left empty), 4 back-left, 5 front-left
  const bots = await seat('design-review', [['Kenji', '#4c8bf5'], ['Maria', '#3fb27f'], null, ['Sam', '#f2a541']]);
  bots[1].hold('sphere', 0.2);
  await sketchRoadmap(bots[0], 'wb1');
  await camera(page, [-0.15, 1.35, 2.25], [0.05, 0.12, -0.55], 45);
  await hideBottomBar(page);
  await settle(page, 2500);
  await page.screenshot({ path: `${OUT}hero.jpg`, type: 'jpeg', quality: 85 });
  bots.forEach((b) => b.close());
  await page.context().close();
}

// 2. Workshop: long table, two boards, eight seats, full HUD.
if (want('workshop')) {
  const page = await newPage();
  await joinPage(page, 'kickoff', 'You');
  await hideToasts(page);
  // far side (odd seats) is visible from the camera; keep the near side mostly empty
  const bots = await seat('kickoff', [['Aiko', '#4c8bf5'], null, ['Chen', '#f2a541'], null, ['Dana', '#9b5de5'], null, ['Ben', '#3fb27f']]);
  await sketchRoadmap(bots[0], 'wb1');
  bots[2].stroke('wb2', '#222222', handwriting(0.1, 0.75, 0.6, 7), 0.004);
  bots[2].stroke('wb2', '#222222', handwriting(0.1, 0.6, 0.5, 8), 0.004);
  bots[2].stroke('wb2', '#1d4ed8', circle(0.3, 0.3, 0.15));
  bots[2].hold('torus', 0.25);
  await camera(page, [-1.25, 1.3, 1.85], [0.35, 0.05, -0.35], 50);
  await settle(page, 2500);
  await page.screenshot({ path: `${OUT}workshop.jpg`, type: 'jpeg', quality: 85 });

  // 3. Host settings dialog over the same room.
  await page.getByRole('button', { name: 'Room settings' }).click();
  await settle(page, 600);
  await page.screenshot({ path: `${OUT}settings.png` });
  bots.forEach((b) => b.close());
  await page.context().close();
}

// 4. Lobby (English and Japanese).
for (const lang of want('lobby') ? (['en', 'ja'] as const) : []) {
  const page = await newPage(2, 1100); // tall enough for the whole card
  await page.goto(`${BASE}/?lang=${lang}`);
  await page.getByRole('button', { name: lang === 'en' ? 'Join' : '参加する' }).waitFor();
  await page.locator('input[name="name"]').fill(lang === 'en' ? 'Alex' : '山田');
  await settle(page, 300);
  await page.locator('#lobby .card').screenshot({ path: `${OUT}lobby${lang === 'ja' ? '-ja' : ''}.png` });
  await page.context().close();
}

// 5. XR (emulated Quest 3, VR mode): wrist panel, controllers, a pen at the board.
if (want('xr')) {
  const page = await newPage(1);
  await joinPage(page, 'xr-demo', 'You', '&emulate=quest3');
  const bots = [await Bot.join('xr-demo', 'Kenji', '#4c8bf5'), await Bot.join('xr-demo', 'Maria', '#3fb27f')];
  for (const b of bots) b.sit();
  await sketchRoadmap(bots[0], 'wb1');
  await page.getByRole('button', { name: 'Enter VR' }).click();
  await page.waitForFunction(() => (window as unknown as { __colo: any }).__colo.renderer.xr.isPresenting); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.evaluate(async () => {
    const w = window as unknown as { __colo: any; __xrDevice: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const app = w.__colo;
    const dev = w.__xrDevice;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await pause(500);
    app.scene.updateMatrixWorld();
    const root = app.frame.root;
    const V = root.position.constructor;
    const Q = root.quaternion.constructor;
    const head = new V(0, 1.2, 0);
    // Look between the table and the board.
    const board = root.localToWorld(new V(1.0, 0.5, 0));
    const table = root.localToWorld(new V(0.2, 0, 0));
    const target = board.clone().add(table).multiplyScalar(0.5);
    const d = target.clone().sub(head);
    const yaw = Math.atan2(-d.x, -d.z);
    const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    const look = new Q().setFromAxisAngle(new V(0, 1, 0), yaw).multiply(new Q().setFromAxisAngle(new V(1, 0, 0), pitch));
    dev.quaternion.set(look.x, look.y, look.z, look.w);
    const fwd = new V(0, 0, -1).applyQuaternion(new Q().setFromAxisAngle(new V(0, 1, 0), yaw));
    const left = new V(-fwd.z, 0, fwd.x).negate();
    // Right hand: pick up the black pen and write on the board.
    const r = dev.controllers.right;
    const pen = app.objects.get('pen-black').root.getWorldPosition(new V());
    r.position.set(pen.x, pen.y, pen.z);
    await pause(250);
    r.updateButtonValue('squeeze', 1);
    await pause(300);
    const toward = root.localToWorld(new V(0, 0.5, 0)).sub(board).normalize(); // from the board towards the table
    const ry = Math.atan2(toward.x, toward.z);
    const tilt = new Q().setFromAxisAngle(new V(0, 1, 0), ry).multiply(new Q().setFromAxisAngle(new V(1, 0, 0), -0.25));
    r.quaternion.set(tilt.x, tilt.y, tilt.z, tilt.w);
    for (let i = 0; i <= 12; i++) {
      const onBoard = root.localToWorld(new V(1.0, 0.25 + 0.012 * i, -0.15 + 0.025 * i));
      const tipToHand = new V(0, 0, 0.108).applyQuaternion(tilt);
      const c = onBoard.clone().add(tipToHand);
      r.position.set(c.x, c.y, c.z);
      await pause(40);
    }
    // Left hand raised in front with the wrist panel facing you.
    const l = dev.controllers.left;
    const lp = head.clone().addScaledVector(fwd, 0.36).addScaledVector(left, 0.16).add(new V(0, -0.27, 0));
    l.position.set(lp.x, lp.y, lp.z);
    const lq = new Q().setFromAxisAngle(new V(0, 1, 0), yaw - 0.3).multiply(new Q().setFromAxisAngle(new V(1, 0, 0), -1.0));
    l.quaternion.set(lq.x, lq.y, lq.z, lq.w);
    await pause(1500);
  });
  await page.screenshot({ path: `${OUT}xr.jpg`, type: 'jpeg', quality: 85 });
  bots.forEach((b) => b.close());
  await page.context().close();
}

await browser.close();
server.kill();
console.log(`screenshots written to ${OUT}`);
