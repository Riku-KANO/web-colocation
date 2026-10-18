// Operational behaviour: config reload (ConfigMap updates), ad-hoc room cleanup, CSP.

import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../server/config/load.ts';
import { watchConfig } from '../server/config/watch.ts';
import { buildCsp, cspHeader } from '../server/http/csp.ts';
import { silentLogger } from '../server/log.ts';
import { MemoryStore } from '../server/store.ts';
import { joinRoom, startServer, type RunningServer } from './helpers.ts';

let running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

const SSO = (email: string) => ({ 'x-forwarded-email': email });

describe('config reload', () => {
  it('removes people who lost access, updates host roles and re-lays out running rooms', async () => {
    const base = { auth: { mode: 'trusted-headers', allowNonLoopback: true } };
    const s = await startServer({ ...base, rooms: { list: [{ id: 'eng', template: 'standard' }] } });
    running.push(s);
    const alice = await joinRoom(s.wsUrl, 'a', { room: 'eng' }, SSO('alice@acme.com'));
    const eve = await joinRoom(s.wsUrl, 'e', { room: 'eng' }, SSO('eve@other.com'));

    s.app.reload(
      parseConfig({
        ...base,
        rooms: { list: [{ id: 'eng', template: 'workshop', hosts: ['alice@acme.com'], access: { allowedDomains: ['acme.com'] } }] },
      }),
    );
    expect(await eve.c.waitFor('error')).toMatchObject({ code: 'forbidden' });
    expect(await eve.c.closed()).toBe(4003);
    const cfg = await alice.c.waitFor('config');
    expect(cfg.config.template).toBe('workshop');
    expect(cfg.self.role).toBe('host');
    expect(cfg.snapshot.peers.map((p) => p.name)).toEqual(['alice']);
    alice.c.close();
  });

  it('watches the config directory like a Kubernetes ConfigMap (symlink swap)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'colo-cm-'));
    const write = (name: string, productName: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'config.yaml'), `branding:\n  productName: ${productName}\n`);
    };
    write('..2026_01', 'First');
    symlinkSync('..2026_01', join(dir, '..data'));
    symlinkSync('..data/config.yaml', join(dir, 'config.yaml'));
    const seen: string[] = [];
    const stop = watchConfig(join(dir, 'config.yaml'), {}, silentLogger, (l) => seen.push(String(l.config.branding.productName)), 50);
    try {
      write('..2026_02', 'Second');
      symlinkSync('..2026_02', join(dir, '..data_tmp'));
      renameSync(join(dir, '..data_tmp'), join(dir, '..data')); // atomic swap, as kubelet does
      const deadline = Date.now() + 3000;
      while (!seen.includes('Second') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(seen).toContain('Second');
    } finally {
      stop();
    }
  });
});

describe('ad-hoc room cleanup', () => {
  it('deletes stale ad-hoc rooms from the store but keeps configured and recent ones', async () => {
    const store = new MemoryStore();
    const old = Date.now() - 10 * 24 * 3600_000;
    const doc = (roomId: string, adhoc: boolean, updatedAt: number) => ({
      schemaVersion: 1 as const,
      roomId,
      adhoc,
      updatedAt,
      settings: {},
      state: { objects: [], strokes: [] },
    });
    await store.save(doc('stale', true, old));
    await store.save(doc('fresh', true, Date.now()));
    await store.save(doc('configured', false, old));
    const s = await startServer({ rooms: { adhocTtlHours: 24, list: [{ id: 'configured' }] } }, { store });
    running.push(s);
    await s.app.registry.sweep();
    expect((await store.list()).map((r) => r.roomId).sort()).toEqual(['configured', 'fresh']);
  });
});

describe('content security policy', () => {
  it('allows only what the configuration needs', () => {
    const { config } = parseConfig({
      branding: { logo: 'https://cdn.acme.com/logo.png' },
      assets: { allowedOrigins: ['https://models.acme.com'] },
    });
    const csp = buildCsp(config, 'xr.acme.com');
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain('wss://xr.acme.com');
    expect(csp).toMatch(/connect-src [^;]*https:\/\/models\.acme\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
    expect(csp).toMatch(/img-src [^;]*https:\/\/cdn\.acme\.com/);
    expect(csp).not.toContain('unsafe-inline');
  });

  it('is report-only by default and can be enforced or disabled', () => {
    const header = (csp: string) => Object.keys(cspHeader(parseConfig({ server: { csp } }).config, 'h'));
    expect(header('report-only')).toEqual(['content-security-policy-report-only']);
    expect(header('enforce')).toEqual(['content-security-policy']);
    expect(header('off')).toEqual([]);
  });

  it('drops the input-profile CDN when offline models are configured', () => {
    expect(buildCsp(parseConfig({ xr: { inputProfilesPath: 'none' } }).config, 'h')).not.toContain('jsdelivr');
  });
});
