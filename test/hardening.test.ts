// Regression tests for the second security review: rate limiting, resource bounds, host rights,
// identity display and HTTP hardening.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { LIMITS, cleanText, parseClientMsg } from '../shared/validate.ts';
import { createServerApp } from '../server/app.ts';
import { isAllowed, trustedHeadersProblem } from '../server/auth.ts';
import { addressKey, clientAddress } from '../server/colocationServer.ts';
import { parseConfig } from '../server/config/load.ts';
import { buildCsp, cspHeader } from '../server/http/csp.ts';
import { documentHeaders } from '../server/http/handler.ts';
import { silentLogger } from '../server/log.ts';
import { hashPasscode } from '../server/passcode.ts';
import { PointBudget, Room } from '../server/room.ts';
import { MemoryStore } from '../server/store.ts';
import { Client, hello, join, joinRoom, roomConfig, startServer, type RunningServer } from './helpers.ts';

const fastHash = (p: string) => hashPasscode(p, { N: 1024, r: 8, p: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: RunningServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('client addresses for rate limiting', () => {
  const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as IncomingMessage;

  it('takes the entry added by the trusted proxies, not what the client sent', () => {
    expect(clientAddress(req('10.0.0.5', '6.6.6.6'), 0)).toBe('10.0.0.5');
    // ALB: "<client-supplied>, <client>"
    expect(clientAddress(req('10.0.0.5', '6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
    // Google Cloud LB: "<client-supplied>, <client>, <lb>"
    expect(clientAddress(req('10.0.0.5', '6.6.6.6, 203.0.113.7, 34.1.1.1'), 2)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.5'), 1)).toBe('10.0.0.5');
  });

  it('groups IPv6 clients by /64', () => {
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(addressKey('192.0.2.1')).toBe('192.0.2.1');
  });
});

describe('identity checks', () => {
  it('reads the email domain after the last @', () => {
    const access = { allowedDomains: ['acme.com'], allowedUsers: [], allowedGroups: [] };
    expect(isAllowed({ email: 'mallory@acme.com@evil.example', user: null, groups: [], name: 'm' }, access)).toBe(false);
    expect(isAllowed({ email: 'alice@acme.com', user: null, groups: [], name: 'a' }, access)).toBe(true);
  });

  it('refuses trusted headers on a non-loopback address, also on reload', () => {
    const sso = parseConfig({ auth: { mode: 'trusted-headers' } });
    expect(trustedHeadersProblem(sso.config.auth, '0.0.0.0')).toMatch(/loopback/);
    expect(trustedHeadersProblem(sso.config.auth, '127.0.0.1')).toBeNull();
    const app = createServerApp({ loaded: parseConfig({}), log: silentLogger, listenHost: '0.0.0.0' });
    app.reload(sso);
    expect(app.registry.config.auth.mode).toBe('none');
    void app.shutdown();
  });

  it('strips control and bidi characters from names and titles', () => {
    expect(cleanText(' Bob‮​\u0007 ')).toBe('Bob');
    const msg = parseClientMsg({ ...hello('Ev‮il'), v: PROTOCOL_VERSION });
    expect(msg && msg.t === 'hello' && msg.name).toBe('Evil');
  });
});

describe('passcode guessing', () => {
  it('counts concurrent guesses before checking them', async () => {
    server = await startServer({ rooms: { list: [{ id: 'locked', passcodeHash: await fastHash('1234') }] } });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const c = new Client(server!.wsUrl);
        await c.opened();
        return c;
      }),
    );
    for (const [i, c] of clients.entries()) c.send(hello('x', { room: 'locked', passcode: `guess-${i}` }));
    const codes = await Promise.all(clients.map(async (c) => (await c.waitFor('error')).code));
    expect(codes.filter((c) => c === 'passcode-invalid').length).toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 'rate-limited').length).toBeGreaterThanOrEqual(15);
    // The right passcode is refused too while the address is blocked.
    const late = new Client(server.wsUrl);
    await late.opened();
    late.send(hello('x', { room: 'locked', passcode: '1234' }));
    expect((await late.waitFor('error')).code).toBe('rate-limited');
  });

  it('does not keep rooms in memory after refused joins', async () => {
    server = await startServer({ rooms: { list: [{ id: 'locked', passcodeHash: await fastHash('1234') }] } }, { emptyRoomTtlMs: 0 });
    const c = new Client(server.wsUrl);
    await c.opened();
    c.send(hello('x', { room: 'locked' }));
    expect((await c.waitFor('error')).code).toBe('passcode-required');
    await sleep(50);
    expect(server.app.registry.rooms.size).toBe(0);
  });
});

describe('connections', () => {
  it('closes sockets that never say hello', async () => {
    server = await startServer({}, { helloTimeoutMs: 100 });
    const c = new Client(server.wsUrl);
    await c.opened();
    expect(await c.closed(2000)).toBe(1006);
  });

  it('marks only names from the identity provider as verified', async () => {
    server = await startServer({ auth: { mode: 'trusted-headers', allowDisplayNameOverride: true } });
    const headers = { 'x-forwarded-email': 'mallory@acme.com' };
    const typed = await joinRoom(server.wsUrl, 'Alice (CEO)', {}, headers);
    expect(typed.self).toMatchObject({ name: 'Alice (CEO)', verified: false });
    const own = await joinRoom(server.wsUrl, '', {}, headers);
    expect(own.self).toMatchObject({ name: 'mallory', verified: true });
  });
});

describe('host settings in rooms from the configuration', () => {
  const config = { rooms: { list: [{ id: 'all-hands', template: 'standard' }] } };
  const settings = (c: Client, s: object) => c.send({ t: 'room-settings', e: c.epoch, settings: s } as never);

  it('lets a first-joiner host adjust the meeting, but not lock or rename the room for good', async () => {
    server = await startServer(config, { emptyRoomTtlMs: 0 });
    const { c } = await joinRoom(server.wsUrl, 'First', { room: 'all-hands' });
    settings(c, { passcode: '0000' });
    expect((await c.waitFor('error')).message).toMatch(/configured hosts/);
    settings(c, { title: 'Closed, see evil.example' });
    await sleep(1100);
    expect(c.inbox.filter((m) => m.t === 'error')).toHaveLength(2);

    settings(c, { template: 'workshop' });
    expect((await c.waitFor('config')).config.template).toBe('workshop');
    // Changes made in the meeting end with it.
    c.close();
    await sleep(100);
    expect(server.app.registry.rooms.size).toBe(0);
    const again = await joinRoom(server.wsUrl, 'Next', { room: 'all-hands' });
    expect(again.welcome.config.template).toBe('standard');
    expect(server.app.registry.lobbyRooms(null)[0]).toMatchObject({ title: 'all-hands', passcode: false });
  });

  it('throttles settings changes', async () => {
    server = await startServer({});
    const { c } = await joinRoom(server.wsUrl, 'Host', { room: 'adhoc' });
    settings(c, { title: 'One' });
    await c.waitFor('config');
    settings(c, { title: 'Two' });
    expect((await c.waitFor('error')).message).toMatch(/too many changes/);
  });

  it('ignores settings saved while the id was an ad-hoc room', async () => {
    const store = new MemoryStore();
    await store.save({
      schemaVersion: 1,
      roomId: 'all-hands',
      adhoc: true,
      updatedAt: Date.now(),
      settings: { title: 'Squatted', passcodeHash: await fastHash('0000') },
      state: { objects: [], strokes: [] },
    });
    server = await startServer(config, { store });
    const { welcome } = await joinRoom(server.wsUrl, 'Owner', { room: 'all-hands' });
    expect(welcome.config.title).toBe('all-hands');
  });
});

describe('whiteboard size', () => {
  it('keeps the snapshot of a full board well below the send buffer cap', () => {
    const room = new Room(roomConfig());
    room.join('a', { send() {} }, join('A'));
    // Full-precision coordinates are quantized on the way in.
    const pts = Array.from({ length: LIMITS.ptsPerMessage }, () => Math.random() * 0.999999);
    for (let i = 0; i * LIMITS.ptsPerMessage < LIMITS.ptsPerRoom; i++) {
      const msg = parseClientMsg({ t: 'stroke', e: room.epoch, id: `s${i}`, board: 'wb1', color: '#112233', width: 0.004, pts });
      room.handle('a', msg!);
    }
    let size = 0;
    room.join('b', { send: (d: string) => void (size = Math.max(size, d.length)) }, join('B'));
    expect(size).toBeGreaterThan(LIMITS.ptsPerRoom * 4);
    expect(size).toBeLessThan(2.5 * 1024 * 1024);
  });
});

describe('shared whiteboard budget', () => {
  it('bounds ink across rooms and frees it when a room is dropped', () => {
    const points = new PointBudget(4000);
    const a = new Room(roomConfig('a'), { hostMode: 'first-joiner', points });
    const b = new Room(roomConfig('b'), { hostMode: 'first-joiner', points });
    const sent: string[] = [];
    a.join('p', { send() {} }, join('P'));
    b.join('q', { send: (d: string) => void sent.push(d) }, join('Q'));
    const stroke = (room: Room, peer: string, id: string) =>
      room.handle(peer, parseClientMsg({ t: 'stroke', e: room.epoch, id, board: 'wb1', color: '#112233', width: 0.004, pts: Array(LIMITS.ptsPerMessage).fill(0.5) })!);
    stroke(a, 'p', 's1');
    stroke(a, 'p', 's2');
    expect(points.used).toBe(4000);
    stroke(b, 'q', 's3');
    expect(sent.some((d) => d.includes('"limit"'))).toBe(true);
    a.releasePoints();
    expect(points.used).toBe(0);
    stroke(b, 'q', 's4');
    expect(points.used).toBe(LIMITS.ptsPerMessage);
  });
});

describe('HTTP hardening', () => {
  it('serves operator assets sandboxed and survives unreadable files', async () => {
    const dir = await mkdtemp(joinPath(tmpdir(), 'colo-assets-'));
    try {
      await writeFile(joinPath(dir, 'page.html'), '<script>alert(1)</script>');
      await writeFile(joinPath(dir, 'locked.glb'), 'x');
      await chmod(joinPath(dir, 'locked.glb'), 0o000);
      server = await startServer({ assets: { dir } });
      const page = await fetch(`${server.base}/room-assets/page.html`);
      expect(page.headers.get('content-security-policy')).toMatch(/^sandbox/);
      await fetch(`${server.base}/room-assets/locked.glb`).then((r) => r.arrayBuffer()).catch(() => null);
      expect((await fetch(`${server.base}/healthz`)).status).toBe(200);
    } finally {
      await chmod(joinPath(dir, 'locked.glb'), 0o600);
      await rm(dir, { recursive: true });
    }
  });

  it('keeps metrics off the public port when a health port serves them', async () => {
    server = await startServer({}, { publicMetrics: false });
    expect((await fetch(`${server.base}/metrics`)).status).toBe(404);
    expect((await fetch(`${server.base}/healthz`)).status).toBe(200);
  });

  it('enforces the CSP by default and allows embedded model data', () => {
    const config = parseConfig({}).config;
    expect(Object.keys(cspHeader(config, 'xr.acme.com'))).toEqual(['content-security-policy']);
    expect(buildCsp(config, 'xr.acme.com')).toMatch(/connect-src 'self' blob: data:/);
    expect(documentHeaders()['x-frame-options']).toBe('SAMEORIGIN');
  });
});
