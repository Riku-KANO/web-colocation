import { readFileSync } from 'node:fs';
import { BoxGeometry, DataTexture, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { ModelError, analyzeModel, checkModel, imageSize, isAllowedModelUrl, modelRadius, precheckModel } from '../src/scene/modelLoader.ts';

const ORIGIN = 'https://xr.acme.com';

describe('model URL policy', () => {
  it('allows same-origin room assets and https URLs from allowed origins only', () => {
    expect(isAllowedModelUrl('/room-assets/drone.glb', [], ORIGIN)).toBe(true);
    expect(isAllowedModelUrl('/room-assets/../secret.glb', [], ORIGIN)).toBe(false);
    expect(isAllowedModelUrl('https://cdn.acme.com/m.glb', ['https://cdn.acme.com'], ORIGIN)).toBe(true);
    expect(isAllowedModelUrl('https://cdn.acme.com/m.glb', ['https://cdn.acme.com/'], ORIGIN)).toBe(true);
    expect(isAllowedModelUrl('https://evil.example/m.glb', ['https://cdn.acme.com'], ORIGIN)).toBe(false);
    expect(isAllowedModelUrl('http://cdn.acme.com/m.glb', ['http://cdn.acme.com'], ORIGIN)).toBe(false);
    expect(isAllowedModelUrl('/other/m.glb', [], ORIGIN)).toBe(false);
    // Files a model refers to arrive as absolute URLs.
    expect(isAllowedModelUrl(`${ORIGIN}/room-assets/drone.bin`, [], ORIGIN)).toBe(true);
    expect(isAllowedModelUrl('//evil.example/room-assets/m.glb', [], ORIGIN)).toBe(false);
    expect(isAllowedModelUrl('data:model/gltf-binary;base64,AAAA', ['https://cdn.acme.com'], ORIGIN)).toBe(false);
  });
});

describe('model limits', () => {
  const model = (boxes: number, texture = 0) => {
    const g = new Group();
    const mat = new MeshStandardMaterial();
    if (texture) mat.map = new DataTexture(new Uint8Array(4), texture, texture);
    for (let i = 0; i < boxes; i++) g.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), mat));
    return g;
  };

  it('counts triangles and the largest texture', () => {
    expect(analyzeModel(model(3, 512))).toEqual({ triangles: 36, maxTexture: 512 });
  });

  it('rejects models over the limits', () => {
    expect(() => checkModel({ triangles: 10, maxTexture: 8192 }, { maxTriangles: 100, maxTextureSize: 4096 })).toThrow(ModelError);
    expect(() => checkModel({ triangles: 1000, maxTexture: 0 }, { maxTriangles: 100, maxTextureSize: 4096 })).toThrow(/triangles/);
    expect(() => checkModel({ triangles: 10, maxTexture: 1024 }, { maxTriangles: 100, maxTextureSize: 4096 })).not.toThrow();
  });

  it('derives a grab radius from the bounds', () => {
    expect(modelRadius(model(1))).toBeCloseTo(Math.sqrt(3) * 0.05);
  });
});

/** A GLB file from a glTF JSON object and an optional binary chunk. */
function glb(json: object, bin = new Uint8Array(0)): ArrayBuffer {
  const pad = (n: number) => (n + 3) & ~3;
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad(text.length);
  const binLen = pad(bin.length);
  const total = 12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(text, 20);
  if (bin.length) {
    v.setUint32(20 + jsonLen, binLen, true);
    v.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(bin, 28 + jsonLen);
  }
  return out.buffer;
}

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe('model checks before decoding', () => {
  const limits = { maxTriangles: 500_000, maxTextureSize: 4096 };

  it('accepts the sample model', () => {
    const drone = readFileSync(new URL('../examples/room-assets/drone.glb', import.meta.url));
    expect(() => precheckModel(drone.buffer.slice(drone.byteOffset, drone.byteOffset + drone.byteLength), limits)).not.toThrow();
  });

  it('rejects declared triangle counts over the limit', () => {
    const file = glb({ asset: { version: '2.0' }, accessors: [{ count: 3_000_000 }], meshes: [{ primitives: [{ attributes: {}, indices: 0 }] }] });
    expect(() => precheckModel(file, limits)).toThrow(/triangles/);
  });

  it('rejects compressed geometry that expands too much', () => {
    const file = glb({ asset: { version: '2.0' }, bufferViews: [{ buffer: 0, byteLength: 16, extensions: { EXT_meshopt_compression: { count: 100_000_000, byteStride: 16 } } }] });
    expect(() => precheckModel(file, limits)).toThrow(/expands/);
  });

  it('rejects embedded images larger than the texture limit from their header', () => {
    const big = png(30_000, 30_000);
    const file = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: big.length }], bufferViews: [{ buffer: 0, byteLength: big.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] }, big);
    expect(() => precheckModel(file, limits)).toThrow(ModelError);
    expect(() => precheckModel(new TextEncoder().encode('not json').buffer, limits)).toThrow(/glTF/);
  });

  it('reads image sizes from PNG, JPEG and WebP headers', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
    const webp = new Uint8Array(32);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    new DataView(webp.buffer).setUint32(24, 639, true);
    new DataView(webp.buffer).setUint32(27, 479, true);
    expect(imageSize(webp)).toEqual({ width: 640, height: 480 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
