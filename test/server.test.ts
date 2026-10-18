// Integration tests against the real HTTP + WebSocket server.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_FATAL, CLOSE_RESTART, PROTOCOL_VERSION, type ServerMsg } from '../shared/protocol.ts';
import { createFileStore } from '../server/fileStore.ts';
import { hashPasscode } from '../server/passcode.ts';
import { Client, joinRoom, startServer, type RunningServer } from './helpers.ts';

let running: RunningServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of running.splice(0)) await s.close();
});

async function start(config: unknown = {}, opts = {}) {
  const s = await startServer(config, opts);
  running.push(s);
  return s;
}

async function joined(url: string, name: string, extra = {}, headers = {}) {
  const r = await joinRoom(url, name, { room: 'it', ...extra }, headers);
  clients.push(r.c);
  return r;
}

const SSO = (email: string, extra: Record<string, string> = {}) => ({ 'x-forwarded-email': email, ...extra });

describe('sync over WebSocket', () => {
  it('moves made by A reach B; release settles the pose; late joiners get the snapshot', async () => {
    const s = await start();
    const a = await joined(s.wsUrl, 'Alice');
    const b = await joined(s.wsUrl, 'Bob');
    await a.c.waitFor('peer-join', (m) => m.peer.id === b.self.id);
    const e = a.welcome.epoch;
    a.c.send({ t: 'grab', e, id: 'cube' });
    await b.c.waitFor('owner', (m) => m.id === 'cube' && m.owner === a.self.id);
    a.c.send({ t: 'move', e, id: 'cube', pose: { p: [0.42, 0.2, 0.1], q: [0, 0, 0, 1] } });
    expect((await b.c.waitFor('move', (m) => m.id === 'cube')).pose.p).toEqual([0.42, 0.2, 0.1]);
    a.c.send({ t: 'release', e, id: 'cube', pose: { p: [0.5, 0.05, 0.1], q: [0, 0, 0, 1] } });
    expect((await b.c.waitFor('owner', (m) => m.id === 'cube' && m.owner === null)).pose?.p).toEqual([0.5, 0.05, 0.1]);
    const c = await joined(s.wsUrl, 'Carol');
    expect(c.welcome.snapshot.objects.find((o) => o.id === 'cube')?.pose.p).toEqual([0.5, 0.05, 0.1]);
    expect(c.self.seat).toBe(2);
    expect(c.welcome.config.template).toBe('standard');
  });

  it('keeps rooms isolated and releases objects when a holder disconnects', async () => {
    const s = await start();
    const a = await joined(s.wsUrl, 'Alice', { room: 'one' });
    const b = await joined(s.wsUrl, 'Bob', { room: 'two' });
    const c = await joined(s.wsUrl, 'Carol', { room: 'one' });
    a.c.send({ t: 'grab', e: 1, id: 'torus' });
    await c.c.waitFor('owner', (m) => m.owner === a.self.id);
    expect(b.c.inbox.some((m) => m.t === 'owner')).toBe(false);
    a.c.close();
    await c.c.waitFor('peer-leave', (m) => m.id === a.self.id);
    await c.c.waitFor('owner', (m) => m.id === 'torus' && m.owner === null);
  });

  it('rejects other protocol versions with a fatal error', async () => {
    const s = await start();
    const c = new Client(s.wsUrl);
    clients.push(c);
    await c.opened();
    c.send({ t: 'hello', v: PROTOCOL_VERSION + 1, room: 'x', name: 'old', color: '#000000', device: 'desktop', space: '' });
    expect(await c.closed()).toBe(CLOSE_FATAL);
    expect(c.inbox[0]).toMatchObject({ t: 'error', code: 'protocol-mismatch' });
  });

  it('rejects WebSocket upgrades from foreign origins', async () => {
    const s = await start();
    const c = new Client(s.wsUrl, { origin: 'https://evil.example' });
    clients.push(c);
    await expect(c.opened()).rejects.toThrow('HTTP 403');
  });
});

describe('HTTP API', () => {
  it('serves client config, health, readiness and metrics; survives malformed paths', async () => {
    const s = await start({
      branding: { productName: 'Acme' },
      rooms: { list: [{ id: 'secret-room', passcodeHash: await hashPasscode('x', { N: 1024, r: 8, p: 1 }) }, { id: 'hidden', unlisted: true }] },
      voice: { turn: { urls: ['turn:t:3478'] } },
    });
    const cfg = await (await fetch(`${s.base}/api/config`)).json();
    expect(cfg.branding.productName).toBe('Acme');
    expect(cfg.rooms).toEqual([{ id: 'secret-room', title: 'secret-room', template: 'standard', passcode: true }]);
    expect(JSON.stringify(cfg)).not.toMatch(/scrypt|turn:/); // no hashes, no TURN details
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.base}/readyz`)).status).toBe(200);
    expect(await (await fetch(`${s.base}/metrics`)).text()).toMatch(/colo_rooms \d/);
    expect((await fetch(`${s.base}/%`)).status).toBe(400);
    expect((await fetch(`${s.base}/room-assets/../package.json`)).status).toBe(404);
  });
});

describe('access control', () => {
  it('trusted-headers: requires an identity, uses the SSO name and applies allow lists and hosts', async () => {
    const s = await start({
      auth: { mode: 'trusted-headers', allowNonLoopback: true },
      rooms: { list: [{ id: 'eng', hosts: ['lead@acme.com'], access: { allowedDomains: ['acme.com'] } }] },
    });
    const anon = new Client(s.wsUrl);
    clients.push(anon);
    await expect(anon.opened()).rejects.toThrow('HTTP 401');

    const lead = await joined(s.wsUrl, 'ignored', { room: 'eng' }, SSO('lead@acme.com'));
    expect(lead.self).toMatchObject({ name: 'lead', verified: true, role: 'host' });
    const dev = await joined(s.wsUrl, 'x', { room: 'eng' }, SSO('dev@acme.com'));
    expect(dev.self.role).toBe('member');

    const outsider = new Client(s.wsUrl, SSO('eve@other.com'));
    clients.push(outsider);
    await outsider.opened();
    outsider.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'eng', name: 'e', color: '#000000', device: 'desktop', space: '' });
    expect(await outsider.waitFor('error')).toMatchObject({ code: 'forbidden' });
    expect(await outsider.closed()).toBe(CLOSE_FATAL);

    const cfg = await (await fetch(`${s.base}/api/config`, { headers: SSO('eve@other.com') })).json();
    expect(cfg.rooms).toEqual([]);
    expect(cfg.auth.identity).toEqual({ name: 'eve', email: 'eve@other.com' });
  });

  it('passcodes: required, wrong, right', async () => {
    const s = await start({ rooms: { list: [{ id: 'p', passcodeHash: await hashPasscode('1234', { N: 1024, r: 8, p: 1 }) }] } });
    const tryJoin = async (passcode?: string) => {
      const c = new Client(s.wsUrl);
      clients.push(c);
      await c.opened();
      c.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'p', name: 'n', color: '#000000', device: 'desktop', space: '', ...(passcode ? { passcode } : {}) });
      await c.closed().catch(() => {}); // fatal errors close the socket
      return c.inbox.find((m) => m.t === 'welcome' || m.t === 'error');
    };
    expect(await tryJoin()).toMatchObject({ code: 'passcode-required' });
    expect(await tryJoin('0000')).toMatchObject({ code: 'passcode-invalid' });
    const ok = new Client(s.wsUrl);
    clients.push(ok);
    await ok.opened();
    ok.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'p', name: 'n', color: '#000000', device: 'desktop', space: '', passcode: '1234' });
    expect(await ok.waitFor('welcome')).toMatchObject({ room: 'p' });
  });

  it('rejects unknown rooms when ad-hoc rooms are disabled', async () => {
    const s = await start({ rooms: { allowAdhoc: false, list: [{ id: 'only' }] } });
    const c = new Client(s.wsUrl);
    clients.push(c);
    await c.opened();
    c.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'other', name: 'n', color: '#000000', device: 'desktop', space: '' });
    expect(await c.waitFor('error')).toMatchObject({ code: 'not-found' });
  });
});

describe('voice ICE servers', () => {
  it('sends STUN + short-lived TURN credentials after joining', async () => {
    const s = await start({ voice: { turn: { urls: ['turn:turn.acme.com:3478'], secretEnv: 'TEST_TURN', ttlSeconds: 600 } } }, { env: { TEST_TURN: 'k' } });
    const a = await joined(s.wsUrl, 'Alice');
    const ice = await a.c.waitFor('ice');
    expect(ice.ttl).toBe(600);
    expect(ice.iceServers.at(-1)).toMatchObject({ urls: ['turn:turn.acme.com:3478'], username: expect.stringMatching(/^\d+:/) });
  });
});

describe('host settings', () => {
  it('a host switches the template; everyone gets the new config; members cannot', async () => {
    const s = await start();
    const host = await joined(s.wsUrl, 'Host');
    const member = await joined(s.wsUrl, 'Member');
    expect(host.self.role).toBe('host');
    member.c.send({ t: 'room-settings', e: 1, settings: { template: 'workshop' } });
    expect(await member.c.waitFor('error')).toMatchObject({ code: 'not-allowed' });
    host.c.send({ t: 'room-settings', e: 1, settings: { template: 'workshop', title: 'Kick-off', rules: { permissions: { clearBoard: 'hosts' } } } });
    const cfg = await member.c.waitFor('config');
    expect(cfg).toMatchObject({ epoch: 2, config: { template: 'workshop', title: 'Kick-off', rules: { permissions: { clearBoard: 'hosts' } } } });
    expect(cfg.self.id).toBe(member.self.id);
    host.c.send({ t: 'room-settings', e: 2, settings: { template: 'does-not-exist' } });
    expect(await host.c.waitFor('error')).toMatchObject({ code: 'invalid-settings' });
  });
});

describe('persistence and shutdown', () => {
  it('closes sockets with 1012 on shutdown and restores state from the file store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'colo-store-'));
    const s1 = await start({}, { store: await createFileStore(dir), saveDelayMs: 10 });
    const a = await joined(s1.wsUrl, 'Alice', { room: 'keep' });
    a.c.send({ t: 'grab', e: 1, id: 'cube' });
    a.c.send({ t: 'release', e: 1, id: 'cube', pose: { p: [0.33, 0.05, 0.1], q: [0, 0, 0, 1] } });
    a.c.send({ t: 'stroke', e: 1, id: 's1', board: 'wb1', color: '#000000', width: 0.004, pts: [0.1, 0.2] });
    a.c.send({ t: 'stroke-end', e: 1, id: 's1' });
    await a.c.waitFor('pong').catch(() => {}); // give the server a moment
    await new Promise((r) => setTimeout(r, 100));
    running = running.filter((x) => x !== s1);
    const closing = a.c.closed();
    await s1.close();
    expect(await closing).toBe(CLOSE_RESTART);

    const s2 = await start({}, { store: await createFileStore(dir) });
    const b = await joined(s2.wsUrl, 'Bob', { room: 'keep' });
    const snap = (b.welcome as Extract<ServerMsg, { t: 'welcome' }>).snapshot;
    expect(snap.objects.find((o) => o.id === 'cube')?.pose.p).toEqual([0.33, 0.05, 0.1]);
    expect(snap.strokes.map((x) => x.id)).toEqual(['s1']);
  });
});
