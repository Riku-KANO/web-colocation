// Resolves templates (with `extends` chains) and room definitions into RoomConfig objects.

import type { Quat } from '../../shared/protocol.ts';
import type {
  BoardSpec,
  Localized,
  ObjectSpec,
  RoomConfig,
  RoomRules,
  RoomSettingsPatch,
  SeatSpec,
  TableSpec,
} from '../../shared/roomConfig.ts';
import { TemplateSchema, type AppConfig, type RoomDefinition, type RulesInput, type Template, type TemplateInput } from './schema.ts';
import { BUILTIN_TEMPLATES } from './templates.ts';

export class ConfigError extends Error {}

const rad = (deg: number) => (deg * Math.PI) / 180;

export type ResolvedTemplate = Omit<RoomConfig, 'id' | 'template'> & { id: string };

export const DEFAULT_RULES: RoomRules = {
  maxParticipants: 16,
  voice: { enabled: true },
  permissions: { clearBoard: 'everyone', resetObjects: 'everyone', editSettings: 'hosts' },
};

const BASE: Omit<ResolvedTemplate, 'id'> = {
  title: 'Room',
  anchor: { kind: 'table', floorOffset: 0.72 },
  environment: { background: '#dfe6ee', floor: 'grid', floorColor: '#d4d9df', light: 1 },
  tables: [],
  seats: [{ x: 0, z: 0.75, yaw: 0 }],
  boards: [],
  objects: [],
  rules: DEFAULT_RULES,
};

/** Euler angles in degrees (XYZ order, same as three.js) → quaternion [x, y, z, w]. */
export function eulerDegToQuat([x, y, z]: readonly [number, number, number]): Quat {
  const c1 = Math.cos(rad(x) / 2);
  const c2 = Math.cos(rad(y) / 2);
  const c3 = Math.cos(rad(z) / 2);
  const s1 = Math.sin(rad(x) / 2);
  const s2 = Math.sin(rad(y) / 2);
  const s3 = Math.sin(rad(z) / 2);
  const r = (v: number) => Math.round(v * 1e9) / 1e9;
  return [
    r(s1 * c2 * c3 + c1 * s2 * s3),
    r(c1 * s2 * c3 - s1 * c2 * s3),
    r(c1 * c2 * s3 + s1 * s2 * c3),
    r(c1 * c2 * c3 - s1 * s2 * s3),
  ];
}

/** Yaw that makes something at `from` face `to` (0 = facing -Z). */
export function yawToward(from: [number, number], to: [number, number]): number {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  if (Math.hypot(dx, dz) < 1e-9) return 0;
  return Math.atan2(-dx, -dz);
}

export function mergeRules(base: RoomRules, patch?: RulesInput | RoomSettingsRules): RoomRules {
  if (!patch) return base;
  return {
    maxParticipants: patch.maxParticipants ?? base.maxParticipants,
    voice: { enabled: patch.voice?.enabled ?? base.voice.enabled },
    permissions: { ...base.permissions, ...stripUndefined(patch.permissions ?? {}) },
  };
}

type RoomSettingsRules = NonNullable<RoomSettingsPatch['rules']>;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function uniqueIds(kind: string, templateId: string, items: Array<{ id: string }>): void {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new ConfigError(`template "${templateId}": duplicate ${kind} id "${it.id}"`);
    seen.add(it.id);
  }
}

function convertTables(t: NonNullable<Template['tables']>): TableSpec[] {
  return t.map((x) => ({
    id: x.id,
    shape: x.shape,
    width: x.width,
    depth: x.shape === 'round' ? x.width : (x.depth ?? x.width),
    height: x.height,
    color: x.color,
    x: x.x,
    z: x.z,
    yaw: rad(x.yaw),
  }));
}

function convertSeats(s: NonNullable<Template['seats']>): SeatSpec[] {
  if (!Array.isArray(s)) {
    const { count, radius, startAngle } = s.auto;
    return Array.from({ length: count }, (_, i) => {
      const a = rad(startAngle + (360 * i) / count);
      const x = Math.round(radius * Math.sin(a) * 1e6) / 1e6;
      const z = Math.round(radius * Math.cos(a) * 1e6) / 1e6;
      return { x, z, yaw: yawToward([x, z], [0, 0]) };
    });
  }
  return s.map((seat) => ({
    x: seat.x,
    z: seat.z,
    yaw: seat.yaw !== undefined ? rad(seat.yaw) : yawToward([seat.x, seat.z], seat.lookAt ?? [0, 0]),
  }));
}

function convertBoards(b: NonNullable<Template['boards']>): BoardSpec[] {
  return b.map((x) => ({ ...x, yaw: rad(x.yaw) }));
}

function convertObjects(o: NonNullable<Template['objects']>): ObjectSpec[] {
  return o.map((x) => ({
    id: x.id,
    kind: x.kind,
    color: x.color,
    pose: { p: [...x.position] as [number, number, number], q: eulerDegToQuat(x.rotation) },
    ...(x.scale !== undefined ? { scale: x.scale } : {}),
    ...(x.model ? { model: { ...x.model } } : {}),
  }));
}

/** All templates (built-in + config), resolved and validated once at startup / reload. */
export class TemplateRegistry {
  private readonly resolved = new Map<string, ResolvedTemplate>();

  constructor(custom: Template[] = [], builtins: readonly TemplateInput[] = BUILTIN_TEMPLATES) {
    const defs = new Map<string, Template>();
    for (const b of builtins) defs.set(b.id, TemplateSchema.parse(b));
    for (const c of custom) defs.set(c.id, c); // config templates may replace built-ins
    for (const id of defs.keys()) this.resolve(id, defs, []);
  }

  get(id: string): ResolvedTemplate | undefined {
    return this.resolved.get(id);
  }

  has(id: string): boolean {
    return this.resolved.has(id);
  }

  list(): Array<{ id: string; title: Localized }> {
    return [...this.resolved.values()].map((t) => ({ id: t.id, title: t.title }));
  }

  private resolve(id: string, defs: Map<string, Template>, stack: string[]): ResolvedTemplate {
    const done = this.resolved.get(id);
    if (done) return done;
    const def = defs.get(id);
    if (!def) throw new ConfigError(`template "${stack.at(-1)}" extends unknown template "${id}"`);
    if (stack.includes(id)) throw new ConfigError(`template inheritance cycle: ${[...stack, id].join(' → ')}`);
    const parent = def.extends ? this.resolve(def.extends, defs, [...stack, id]) : { id: '', ...BASE };

    const objects = def.objects ? convertObjects(def.objects) : parent.objects;
    const t: ResolvedTemplate = {
      id,
      title: def.title ?? (def.extends ? parent.title : id),
      anchor: def.anchor ?? parent.anchor,
      environment: { ...parent.environment, ...stripUndefined(def.environment ?? {}) },
      tables: def.tables ? convertTables(def.tables) : parent.tables,
      seats: def.seats ? convertSeats(def.seats) : parent.seats,
      boards: def.boards ? convertBoards(def.boards) : parent.boards,
      objects: def.addObjects ? [...objects, ...convertObjects(def.addObjects)] : objects,
      rules: mergeRules(parent.rules, def.rules),
    };
    uniqueIds('table', id, t.tables);
    uniqueIds('board', id, t.boards);
    uniqueIds('object', id, t.objects);
    if (t.anchor.kind === 'floor' && t.anchor.floorOffset !== 0) {
      throw new ConfigError(`template "${id}": a floor anchor must have floorOffset 0`);
    }
    this.resolved.set(id, t);
    return t;
  }
}

export function buildRoomConfig(
  roomId: string,
  title: Localized,
  tpl: ResolvedTemplate,
  overrides?: RoomDefinition['overrides'],
): RoomConfig {
  return {
    id: roomId,
    title,
    template: tpl.id,
    anchor: tpl.anchor,
    environment: { ...tpl.environment, ...stripUndefined(overrides?.environment ?? {}) },
    tables: tpl.tables,
    seats: tpl.seats,
    boards: tpl.boards,
    objects: tpl.objects,
    rules: mergeRules(tpl.rules, overrides?.rules),
  };
}

/** Cross-reference checks that the schema alone cannot express. */
export function validateReferences(config: AppConfig, templates: TemplateRegistry): void {
  if (!templates.has(config.rooms.adhocTemplate)) {
    throw new ConfigError(`rooms.adhocTemplate: unknown template "${config.rooms.adhocTemplate}"`);
  }
  const ids = new Set<string>();
  config.rooms.list.forEach((r, i) => {
    if (ids.has(r.id)) throw new ConfigError(`rooms.list[${i}]: duplicate room id "${r.id}"`);
    ids.add(r.id);
    if (!templates.has(r.template)) throw new ConfigError(`rooms.list[${i}] (${r.id}): unknown template "${r.template}"`);
  });
}
