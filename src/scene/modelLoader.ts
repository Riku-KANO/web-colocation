// Loads operator-provided glTF/GLB models for `kind: model` objects.
//
// Models are untrusted input, so the loader enforces limits before anything is added to the
// scene: allowed origins, download size (streamed), triangle count and texture resolution.
// Each URL is downloaded once and cloned for every object that uses it.

import { Box3, Mesh, Sphere, type Material, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export interface ModelPolicy {
  /** https origins allowed in addition to the same-origin /room-assets/ path. */
  allowedOrigins: string[];
  maxBytes: number;
  maxTriangles: number;
  maxTextureSize: number;
}

export const DEFAULT_MODEL_LIMITS = { maxTriangles: 500_000, maxTextureSize: 4096 };

export class ModelError extends Error {}

/** Same-origin room assets, or https URLs from an allowed origin. */
export function isAllowedModelUrl(src: string, allowedOrigins: string[], pageOrigin = location.origin): boolean {
  if (src.startsWith('/room-assets/') && !src.includes('..')) return true;
  let url: URL;
  try {
    url = new URL(src, pageOrigin);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && allowedOrigins.some((o) => o.replace(/\/$/, '') === url.origin);
}

export interface ModelStats {
  triangles: number;
  maxTexture: number;
}

export function analyzeModel(root: Object3D): ModelStats {
  let triangles = 0;
  let maxTexture = 0;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Array<Material & Record<string, unknown>>;
    for (const m of mats)
      for (const v of Object.values(m)) {
        const tex = v as Texture | null;
        const img = tex?.isTexture ? (tex.image as { width?: number; height?: number } | undefined) : undefined;
        if (img?.width) maxTexture = Math.max(maxTexture, img.width, img.height ?? 0);
      }
  });
  return { triangles: Math.round(triangles), maxTexture };
}

export function checkModel(stats: ModelStats, policy: Pick<ModelPolicy, 'maxTriangles' | 'maxTextureSize'>): void {
  if (stats.triangles > policy.maxTriangles) throw new ModelError(`model has ${stats.triangles} triangles (limit ${policy.maxTriangles})`);
  if (stats.maxTexture > policy.maxTextureSize) throw new ModelError(`model texture is ${stats.maxTexture}px (limit ${policy.maxTextureSize})`);
}

/** Bounding-sphere radius of a model, used as the near-grab radius. */
export function modelRadius(root: Object3D): number {
  const sphere = new Box3().setFromObject(root).getBoundingSphere(new Sphere());
  return Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0.1;
}

async function download(url: string, maxBytes: number): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new ModelError(`HTTP ${res.status} for ${url}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new ModelError(`model is ${declared} bytes (limit ${maxBytes})`);
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ModelError(`model exceeds ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
}

export class ModelLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<Object3D>>();
  private readonly policy: ModelPolicy;

  constructor(policy: ModelPolicy) {
    this.policy = policy;
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.loader.setCrossOrigin('anonymous');
  }

  /** A fresh clone of the model (materials are cloned too so highlights don't leak). */
  async load(src: string): Promise<Object3D> {
    const template = await this.template(src);
    const clone = template.clone(true);
    clone.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
    });
    return clone;
  }

  private template(src: string): Promise<Object3D> {
    let p = this.cache.get(src);
    if (!p) {
      p = this.fetchAndParse(src);
      p.catch(() => this.cache.delete(src)); // allow a retry later
      this.cache.set(src, p);
    }
    return p;
  }

  private async fetchAndParse(src: string): Promise<Object3D> {
    if (!isAllowedModelUrl(src, this.policy.allowedOrigins)) throw new ModelError(`model URL not allowed: ${src}`);
    const url = new URL(src, location.href);
    const data = await download(url.href, this.policy.maxBytes);
    const base = url.href.slice(0, url.href.lastIndexOf('/') + 1);
    const gltf = await this.loader.parseAsync(data, base);
    checkModel(analyzeModel(gltf.scene), this.policy);
    return gltf.scene;
  }
}
