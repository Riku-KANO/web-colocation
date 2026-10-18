import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, parseConfig, runtimeFromEnv } from '../server/config/load.ts';
import { ConfigError, TemplateRegistry, buildRoomConfig, eulerDegToQuat, yawToward } from '../server/config/resolve.ts';
import { AppConfigSchema } from '../server/config/schema.ts';

describe('built-in templates', () => {
  const reg = new TemplateRegistry();

  it('all resolve with consistent ids and enough seats', () => {
    for (const id of ['standard', 'round-table', 'workshop', 'presentation']) {
      const t = reg.get(id)!;
      expect(t, id).toBeDefined();
      expect(t.seats.length).toBeGreaterThanOrEqual(t.rules.maxParticipants);
      expect(new Set(t.objects.map((o) => o.id)).size).toBe(t.objects.length);
      expect(t.boards.length).toBeGreaterThan(0);
    }
  });

  it('standard reproduces the original layout', () => {
    const t = reg.get('standard')!;
    expect(t.anchor).toEqual({ kind: 'table', floorOffset: 0.72 });
    expect(t.boards[0]).toMatchObject({ id: 'wb1', x: 1, y: 0.5, z: 0, width: 1.2, height: 0.8 });
    expect(t.boards[0].yaw).toBeCloseTo(-Math.PI / 2);
    const pen = t.objects.find((o) => o.id === 'pen-black')!;
    expect(pen.pose.q[1]).toBeCloseTo(Math.SQRT1_2);
    // seat 0 looks at the table centre
    const s = t.seats[0];
    expect(s.yaw).toBeCloseTo(Math.atan2(s.x, s.z));
  });

  it('auto seats are spread on a circle facing the centre', () => {
    const seats = reg.get('round-table')!.seats;
    expect(seats).toHaveLength(6);
    for (const s of seats) {
      expect(Math.hypot(s.x, s.z)).toBeCloseTo(0.95);
      expect(s.yaw).toBeCloseTo(yawToward([s.x, s.z], [0, 0]));
    }
  });

  it('presentation is anchored on the floor with audience facing the board', () => {
    const t = reg.get('presentation')!;
    expect(t.anchor.kind).toBe('floor');
    expect(t.seats.slice(1).every((s) => s.yaw === 0)).toBe(true);
  });
});

describe('template inheritance', () => {
  it('extends, overrides and appends objects', () => {
    const reg = new TemplateRegistry([
      {
        id: 'demo',
        extends: 'round-table',
        environment: { background: '#000000' },
        addObjects: [{ id: 'drone', kind: 'model', color: '#9aa3ad', position: [0, 0.1, 0], rotation: [0, 0, 0], model: { src: '/room-assets/drone.glb', scale: 0.3 } }],
        rules: { permissions: { clearBoard: 'hosts' } },
      },
    ] as never);
    const t = reg.get('demo')!;
    expect(t.environment.background).toBe('#000000');
    expect(t.environment.floor).toBe('grid'); // inherited
    expect(t.objects.at(-1)).toMatchObject({ id: 'drone', kind: 'model', model: { src: '/room-assets/drone.glb', scale: 0.3 } });
    expect(t.objects.length).toBe(reg.get('round-table')!.objects.length + 1);
    expect(t.rules.permissions).toMatchObject({ clearBoard: 'hosts', resetObjects: 'everyone' });
    expect(t.seats).toEqual(reg.get('round-table')!.seats);
  });

  it('reports cycles, unknown parents and duplicate ids', () => {
    const parse = (templates: unknown[]) => () => parseConfig({ templates });
    expect(parse([{ id: 'a', extends: 'b' }, { id: 'b', extends: 'a' }])).toThrow(/cycle/);
    expect(parse([{ id: 'a', extends: 'missing' }])).toThrow(/unknown template "missing"/);
    expect(
      parse([
        {
          id: 'a',
          objects: [
            { id: 'x', kind: 'cube', position: [0, 0, 0] },
            { id: 'x', kind: 'cube', position: [0, 0, 0] },
          ],
        },
      ]),
    ).toThrow(/duplicate object id "x"/);
  });
});

describe('config loading', () => {
  it('applies defaults', () => {
    const { config } = parseConfig({});
    expect(config.auth.mode).toBe('none');
    expect(config.rooms.allowAdhoc).toBe(true);
    expect(config.storage.driver).toBe('memory');
  });

  it('gives readable errors with the path of the problem', () => {
    expect(() => parseConfig({ rooms: { list: [{ id: 'has space' }] } })).toThrow(/rooms\.list\[0\]\.id/);
    expect(() => parseConfig({ rooms: { list: [{ id: 'a', template: 'nope' }] } })).toThrow(/unknown template "nope"/);
    expect(() => parseConfig({ auth: { mode: 'oidc' } })).toThrow(ConfigError);
    expect(() => parseConfig({ unknownKey: 1 })).toThrow(/unknownKey/);
  });

  it('reads YAML files and environment overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'colo-'));
    const file = join(dir, 'config.yaml');
    writeFileSync(
      file,
      `branding:
  productName: { en: Acme Rooms, ja: アクメ }
rooms:
  list:
    - id: design-review
      template: workshop
      hosts: [lead@acme.com]
`,
    );
    const { config, source } = loadConfig(file, { COLO_STORAGE_DRIVER: 'file', COLO_STORAGE_DIR: '/tmp/x' });
    expect(source).toBe(file);
    expect(config.branding.productName).toEqual({ en: 'Acme Rooms', ja: 'アクメ' });
    expect(config.rooms.list[0]).toMatchObject({ id: 'design-review', template: 'workshop', hosts: ['lead@acme.com'] });
    expect(config.storage).toEqual({ driver: 'file', dir: '/tmp/x' });
    expect(() => loadConfig(join(dir, 'missing.yaml'))).toThrow(/cannot read/);
  });

  it('runtime options come from the environment', () => {
    expect(runtimeFromEnv({ PORT: '9000', HEALTH_PORT: '9001', HOST: '127.0.0.1' })).toMatchObject({ port: 9000, healthPort: 9001, host: '127.0.0.1' });
    expect(() => runtimeFromEnv({ PORT: 'abc' })).toThrow(/port/);
  });

  it('exports a JSON Schema for editors and the Helm chart', () => {
    const schema = z.toJSONSchema(AppConfigSchema, { io: 'input' }) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['server', 'auth', 'branding', 'voice', 'storage', 'rooms', 'templates']),
    );
  });
});

describe('room config', () => {
  it('applies room overrides on top of the template', () => {
    const reg = new TemplateRegistry();
    const cfg = buildRoomConfig('x', 'X', reg.get('standard')!, { rules: { maxParticipants: 2 }, environment: { light: 2 } });
    expect(cfg.rules.maxParticipants).toBe(2);
    expect(cfg.environment.light).toBe(2);
    expect(cfg).not.toHaveProperty('hosts');
  });

  it('converts Euler degrees like three.js (XYZ order)', () => {
    const q = eulerDegToQuat([90, 0, 0]);
    expect(q[0]).toBeCloseTo(Math.SQRT1_2);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2);
  });
});
