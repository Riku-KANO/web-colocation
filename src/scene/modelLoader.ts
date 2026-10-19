// Loads operator-provided glTF/GLB models for `kind: model` objects.
//
// Models are untrusted input, so the loader enforces limits before anything is added to the
// scene: allowed origins (also for redirects and files the model refers to), download size
// (streamed), and triangle count, decoded size and texture resolution, checked from the file's
// JSON before decoding and again on the result. Each URL is downloaded once and cloned for every
// object that uses it.

import { Box3, LoadingManager, Mesh, Sphere, type Material, type Object3D, type Texture } from 'three';
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
/** Geometry that compressed (meshopt) buffers may expand to. */
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

export class ModelError extends Error {}

/** Same-origin room assets, or https URLs from an allowed origin. */
export function isAllowedModelUrl(src: string, allowedOrigins: string[], pageOrigin = location.origin): boolean {
  if (src.includes('..')) return false;
  let url: URL;
  try {
    url = new URL(src, pageOrigin);
  } catch {
    return false;
  }
  if (url.origin === pageOrigin && url.pathname.startsWith('/room-assets/')) return true;
  return url.protocol === 'https:' && allowedOrigins.some((o) => o.replace(/\/$/, '') === url.origin);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Width and height from a PNG, JPEG or WebP header, or null for other formats. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 'PNG')) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length >= 32 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) return { width: 1 + (v.getUint32(24, true) & 0xffffff), height: 1 + (v.getUint32(27, true) & 0xffffff) };
    if (ascii(12, 'VP8L')) {
      const bits = v.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (ascii(12, 'VP8 ')) return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the start-of-frame marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      }
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}

/**
 * Checks a glTF/GLB file before three.js decodes it: what it declares (triangles, meshopt-decoded
 * sizes, embedded image dimensions) is enough to reject files built to exhaust memory while
 * decoding, which a check of the loaded scene would only see afterwards.
 */
export function precheckModel(data: ArrayBuffer, policy: Pick<ModelPolicy, 'maxTriangles' | 'maxTextureSize'>): void {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  let json: any;
  let bin: Uint8Array | null = null;
  try {
    if (bytes.length >= 20 && view.getUint32(0, true) === 0x46546c67 /* glTF */) {
      const jsonLength = view.getUint32(12, true);
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
      const at = 20 + jsonLength;
      if (at + 8 <= bytes.length && view.getUint32(at + 4, true) === 0x004e4942 /* BIN */) {
        bin = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + view.getUint32(at, true)));
      }
    } else {
      json = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch {
    throw new ModelError('not a glTF file');
  }
  if (!json || typeof json !== 'object') throw new ModelError('not a glTF file');
  const accessors: any[] = Array.isArray(json.accessors) ? json.accessors : [];
  const views: any[] = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const count = (i: unknown) => Number(accessors[Number(i)]?.count) || 0;

  let triangles = 0;
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    for (const p of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      if ((p?.mode ?? 4) < 4) continue; // points and lines
      triangles += (p.indices !== undefined ? count(p.indices) : count(p.attributes?.POSITION)) / 3;
    }
  }
  if (triangles > policy.maxTriangles) throw new ModelError(`model has ${Math.round(triangles)} triangles (limit ${policy.maxTriangles})`);

  let decoded = 0;
  for (const bv of views) {
    const m = bv?.extensions?.EXT_meshopt_compression ?? bv?.extensions?.KHR_meshopt_compression;
    if (m) decoded += (Number(m.count) || 0) * (Number(m.byteStride) || 0);
  }
  if (decoded > MAX_DECODED_BYTES) throw new ModelError(`model expands to ${decoded} bytes (limit ${MAX_DECODED_BYTES})`);

  if (bin) {
    for (const img of Array.isArray(json.images) ? json.images : []) {
      const bv = views[Number(img?.bufferView)];
      if (!bv || Number(bv.buffer ?? 0) !== 0) continue;
      const start = Number(bv.byteOffset ?? 0);
      const size = imageSize(bin.subarray(start, start + Number(bv.byteLength ?? 0)));
      if (size && Math.max(size.width, size.height) > policy.maxTextureSize) {
        throw new ModelError(`model texture is ${Math.max(size.width, size.height)}px (limit ${policy.maxTextureSize})`);
      }
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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

async function download(url: string, maxBytes: number, allowed: (url: string) => boolean): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new ModelError(`HTTP ${res.status} for ${url}`);
  // A redirect may lead anywhere: the final URL must be allowed too.
  if (res.url && !allowed(res.url)) throw new ModelError(`model URL redirected to a URL that is not allowed: ${res.url}`);
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
  private readonly loader: GLTFLoader;
  private readonly cache = new Map<string, Promise<Object3D>>();
  private readonly policy: ModelPolicy;
  private readonly allowed: (url: string) => boolean;

  constructor(policy: ModelPolicy) {
    this.policy = policy;
    this.allowed = (url) => isAllowedModelUrl(url, policy.allowedOrigins);
    // Buffers and images a model refers to obey the same origin rules as the model itself.
    // blob:/data: URLs are the model's own embedded data.
    const manager = new LoadingManager();
    manager.setURLModifier((url) => (url.startsWith('blob:') || url.startsWith('data:') || this.allowed(url) ? url : 'blocked:'));
    this.loader = new GLTFLoader(manager);
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
    if (!this.allowed(src)) throw new ModelError(`model URL not allowed: ${src}`);
    const url = new URL(src, location.href);
    const data = await download(url.href, this.policy.maxBytes, this.allowed);
    precheckModel(data, this.policy);
    const base = url.href.slice(0, url.href.lastIndexOf('/') + 1);
    const gltf = await this.loader.parseAsync(data, base);
    checkModel(analyzeModel(gltf.scene), this.policy);
    return gltf.scene;
  }
}
