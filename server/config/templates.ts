// Built-in room templates. They use the same input format as config files (meters, degrees),
// so they double as examples. Operators can `extends:` any of them.

import type { TemplateInput } from './schema.ts';

const penObjects = (positions: Array<[number, number, number, number]>, colors = ['#222222', '#d62828', '#1d4ed8', '#15803d']) =>
  positions.map(([x, y, z, yaw], i) => ({
    id: `pen-${i + 1}`,
    kind: 'pen' as const,
    color: colors[i % colors.length],
    position: [x, y, z] as [number, number, number],
    rotation: [0, yaw, 0] as [number, number, number],
  }));

/** Rectangular table with two people facing each other and a whiteboard at the +X end. */
const standard: TemplateInput = {
  id: 'standard',
  title: { en: 'Standard table', ja: '標準テーブル' },
  anchor: { kind: 'table', floorOffset: 0.72 },
  tables: [{ id: 'main', shape: 'rect', width: 1.4, depth: 0.8, height: 0.72 }],
  seats: [
    { x: -0.1, z: 0.75 },
    { x: -0.1, z: -0.75 },
    { x: -1.05, z: 0 },
    { x: 0.45, z: 0.75 },
    { x: 0.45, z: -0.75 },
    { x: -0.6, z: 0.75 },
    { x: -0.6, z: -0.75 },
  ],
  boards: [{ id: 'wb1', x: 1.0, y: 0.5, z: 0, yaw: -90, width: 1.2, height: 0.8 }],
  objects: [
    { id: 'cube', kind: 'cube', color: '#e4572e', position: [-0.35, 0.05, 0] },
    { id: 'sphere', kind: 'sphere', color: '#4c8bf5', position: [-0.1, 0.06, 0.05] },
    { id: 'cone', kind: 'cone', color: '#f2c14e', position: [0.15, 0.06, -0.05] },
    { id: 'torus', kind: 'torus', color: '#3fb27f', position: [0.4, 0.05, 0.05] },
    { id: 'pen-black', kind: 'pen', color: '#222222', position: [0.2, 0.012, 0.3], rotation: [0, 90, 0] },
    { id: 'pen-red', kind: 'pen', color: '#d62828', position: [0.2, 0.012, -0.3], rotation: [0, -90, 0] },
  ],
  rules: {
    maxParticipants: 7,
    voice: { enabled: true },
    permissions: { clearBoard: 'everyone', resetObjects: 'everyone', editSettings: 'hosts' },
  },
};

/** Round table for six with a board behind seat 3. */
const roundTable: TemplateInput = {
  id: 'round-table',
  title: { en: 'Round table (6)', ja: '丸テーブル (6人)' },
  anchor: { kind: 'table', floorOffset: 0.72 },
  tables: [{ id: 'main', shape: 'round', width: 1.3, height: 0.72, color: '#8f6d4e' }],
  seats: { auto: { count: 6, radius: 0.95, startAngle: 0 } },
  boards: [{ id: 'wb1', x: 0, y: 0.6, z: -1.75, yaw: 0, width: 1.4, height: 0.9 }],
  objects: [
    { id: 'sphere', kind: 'sphere', color: '#4c8bf5', position: [-0.15, 0.06, 0.1] },
    { id: 'cube', kind: 'cube', color: '#e4572e', position: [0.18, 0.05, -0.05] },
    { id: 'torus', kind: 'torus', color: '#3fb27f', position: [0, 0.05, -0.25] },
    ...penObjects([
      [0.35, 0.012, 0.25, 35],
      [-0.35, 0.012, 0.25, -35],
    ]),
  ],
  rules: { maxParticipants: 6 },
};

/** Long workshop table for eight with a whiteboard at each end. */
const workshop: TemplateInput = {
  id: 'workshop',
  title: { en: 'Workshop (8)', ja: 'ワークショップ (8人)' },
  anchor: { kind: 'table', floorOffset: 0.72 },
  tables: [{ id: 'main', shape: 'rect', width: 2.4, depth: 1.0, height: 0.72, color: '#c9a77c' }],
  seats: [
    { x: -0.9, z: 0.85 },
    { x: -0.9, z: -0.85 },
    { x: -0.3, z: 0.85 },
    { x: -0.3, z: -0.85 },
    { x: 0.3, z: 0.85 },
    { x: 0.3, z: -0.85 },
    { x: 0.9, z: 0.85 },
    { x: 0.9, z: -0.85 },
  ].map((s) => ({ ...s, lookAt: [s.x, 0] as [number, number] })),
  boards: [
    { id: 'wb1', x: 1.75, y: 0.55, z: 0, yaw: -90, width: 1.4, height: 0.9 },
    { id: 'wb2', x: -1.75, y: 0.55, z: 0, yaw: 90, width: 1.4, height: 0.9 },
  ],
  objects: [
    { id: 'cube', kind: 'cube', color: '#e4572e', position: [-0.6, 0.05, 0] },
    { id: 'sphere', kind: 'sphere', color: '#4c8bf5', position: [-0.2, 0.06, 0.1] },
    { id: 'cone', kind: 'cone', color: '#f2c14e', position: [0.2, 0.06, -0.1] },
    { id: 'torus', kind: 'torus', color: '#3fb27f', position: [0.6, 0.05, 0] },
    ...penObjects([
      [-0.6, 0.012, 0.4, 90],
      [-0.6, 0.012, -0.4, -90],
      [0.6, 0.012, 0.4, 90],
      [0.6, 0.012, -0.4, -90],
    ]),
  ],
  rules: { maxParticipants: 8 },
};

/** No meeting table: a large board, a presenter spot and two rows of audience seats. */
const presentation: TemplateInput = {
  id: 'presentation',
  title: { en: 'Presentation', ja: 'プレゼンテーション' },
  anchor: { kind: 'floor', floorOffset: 0 },
  tables: [{ id: 'podium', shape: 'rect', width: 0.6, depth: 0.45, height: 1.0, color: '#5b6270', x: 1.55, z: -1.5 }],
  seats: [
    // seat 0: the presenter, next to the board, facing the audience
    { x: 1.2, z: -1.2, lookAt: [0, 0.6] },
    // two rows facing the board (yaw 0 = looking towards -Z)
    ...[0, 1.1].flatMap((z) => [-1.2, -0.4, 0.4, 1.2].map((x) => ({ x, z, yaw: 0 }))),
  ],
  boards: [{ id: 'main', x: 0, y: 1.45, z: -2.2, yaw: 0, width: 2.6, height: 1.45 }],
  objects: [
    { id: 'sphere', kind: 'sphere', color: '#4c8bf5', position: [1.45, 1.06, -1.45] },
    ...penObjects([
      [1.65, 1.012, -1.42, 90],
      [1.65, 1.012, -1.58, 90],
    ]),
  ],
  rules: { maxParticipants: 9, permissions: { clearBoard: 'hosts', resetObjects: 'hosts' } },
};

export const BUILTIN_TEMPLATES: readonly TemplateInput[] = [standard, roundTable, workshop, presentation];
