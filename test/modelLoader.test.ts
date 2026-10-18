import { BoxGeometry, DataTexture, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { ModelError, analyzeModel, checkModel, isAllowedModelUrl, modelRadius } from '../src/scene/modelLoader.ts';

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
