// Generates examples/room-assets/drone.glb — a small sample model for custom-object demos.
// The model is built from three.js primitives and written as a minimal glTF 2.0 binary, so it
// is entirely our own work (Apache-2.0) and needs no third-party assets.
//
//   node scripts/make-sample-model.ts

import { writeFileSync } from 'node:fs';
import { BoxGeometry, CylinderGeometry, Euler, Quaternion, SphereGeometry, type BufferGeometry } from 'three';

interface Part {
  name: string;
  geometry: BufferGeometry;
  color: [number, number, number, number];
  metallic: number;
  roughness: number;
  translation: [number, number, number];
  rotation?: [number, number, number]; // radians, XYZ
}

const gray: Part['color'] = [0.18, 0.2, 0.24, 1];
const light: Part['color'] = [0.85, 0.87, 0.9, 1];
const accent: Part['color'] = [0.95, 0.45, 0.1, 1];

const parts: Part[] = [
  { name: 'body', geometry: new BoxGeometry(0.14, 0.04, 0.14), color: gray, metallic: 0.3, roughness: 0.4, translation: [0, 0.03, 0] },
  { name: 'canopy', geometry: new SphereGeometry(0.045, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), color: accent, metallic: 0.1, roughness: 0.3, translation: [0, 0.05, 0] },
  { name: 'camera', geometry: new SphereGeometry(0.018, 16, 12), color: [0.05, 0.05, 0.06, 1], metallic: 0.6, roughness: 0.2, translation: [0, 0.008, 0.06] },
];
for (let i = 0; i < 4; i++) {
  const a = Math.PI / 4 + (i * Math.PI) / 2;
  const x = Math.sin(a);
  const z = Math.cos(a);
  parts.push({
    name: `arm-${i}`,
    geometry: new BoxGeometry(0.012, 0.012, 0.13),
    color: gray,
    metallic: 0.3,
    roughness: 0.5,
    translation: [x * 0.09, 0.035, z * 0.09],
    rotation: [0, a, 0],
  });
  parts.push({
    name: `motor-${i}`,
    geometry: new CylinderGeometry(0.012, 0.012, 0.025, 16),
    color: gray,
    metallic: 0.5,
    roughness: 0.4,
    translation: [x * 0.15, 0.045, z * 0.15],
  });
  parts.push({
    name: `rotor-${i}`,
    geometry: new CylinderGeometry(0.05, 0.05, 0.004, 32),
    color: light,
    metallic: 0,
    roughness: 0.6,
    translation: [x * 0.15, 0.06, z * 0.15],
  });
}

const chunks: Buffer[] = [];
let offset = 0;
const bufferViews: object[] = [];
const accessors: object[] = [];
function addView(data: Buffer, target: number): number {
  const pad = (4 - (data.length % 4)) % 4;
  chunks.push(data, Buffer.alloc(pad));
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
  offset += data.length + pad;
  return bufferViews.length - 1;
}

const meshes: object[] = [];
const materials: object[] = [];
const nodes: object[] = [];
for (const part of parts) {
  const g = part.geometry;
  const pos = g.getAttribute('position').array as Float32Array;
  const nor = g.getAttribute('normal').array as Float32Array;
  const idx = g.getIndex()!.array as Uint16Array | Uint32Array;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  const count = pos.length / 3;
  const pView = addView(Buffer.from(new Float32Array(pos).buffer), 34962);
  accessors.push({ bufferView: pView, componentType: 5126, count, type: 'VEC3', min, max });
  const nView = addView(Buffer.from(new Float32Array(nor).buffer), 34962);
  accessors.push({ bufferView: nView, componentType: 5126, count, type: 'VEC3' });
  const indices = new Uint32Array(idx);
  const iView = addView(Buffer.from(indices.buffer), 34963);
  accessors.push({ bufferView: iView, componentType: 5125, count: indices.length, type: 'SCALAR' });
  const a0 = accessors.length - 3;
  materials.push({
    name: part.name,
    pbrMetallicRoughness: { baseColorFactor: part.color, metallicFactor: part.metallic, roughnessFactor: part.roughness },
  });
  meshes.push({ name: part.name, primitives: [{ attributes: { POSITION: a0, NORMAL: a0 + 1 }, indices: a0 + 2, material: materials.length - 1 }] });
  const node: Record<string, unknown> = { name: part.name, mesh: meshes.length - 1, translation: part.translation };
  if (part.rotation) {
    const q = new Quaternion().setFromEuler(new Euler(...part.rotation));
    node.rotation = [q.x, q.y, q.z, q.w];
  }
  nodes.push(node);
}

const bin = Buffer.concat(chunks);
const gltf = {
  asset: { version: '2.0', generator: 'web-colocation scripts/make-sample-model.ts', copyright: 'The web-colocation Authors, Apache-2.0' },
  scene: 0,
  scenes: [{ name: 'drone', nodes: [nodes.length] }],
  nodes: [...nodes, { name: 'drone', children: nodes.map((_, i) => i) }],
  meshes,
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
const total = 12 + 8 + json.length + 8 + bin.length;
header.writeUInt32LE(0x46546c67, 0); // 'glTF'
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const chunk = (type: number, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};
const out = Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
const file = new URL('../examples/room-assets/drone.glb', import.meta.url);
writeFileSync(file, out);
console.log(`wrote ${file.pathname} (${out.length} bytes, ${parts.length} parts)`);
