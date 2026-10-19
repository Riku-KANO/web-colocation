// Safe static file serving for the built SPA (dist/) and operator assets (/room-assets/).

import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Decode a URL path; null for malformed escapes (`/%`) or NUL bytes. */
export function decodePath(pathname: string): string | null {
  try {
    const p = decodeURIComponent(pathname);
    return p.includes('\0') ? null : p;
  } catch {
    return null;
  }
}

/**
 * Resolve `relPath` inside `root`, following symlinks (Kubernetes ConfigMap mounts are symlinks
 * into `..data/`) and refusing anything that ends up outside the real root directory.
 */
export async function resolveInside(root: string, relPath: string): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return null;
  }
  let real: string;
  try {
    real = await realpath(join(realRoot, relPath));
  } catch {
    return null;
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return real === realRoot || real.startsWith(prefix) ? real : null;
}

export interface SendFileOptions {
  cacheControl: string;
  extraHeaders?: Record<string, string>;
  maxBytes?: number;
}

export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, opts: SendFileOptions): Promise<boolean> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  if (opts.maxBytes !== undefined && info.size > opts.maxBytes) {
    res.writeHead(413, { 'content-type': 'text/plain' }).end('file too large');
    return true;
  }
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': opts.cacheControl,
    'x-content-type-options': 'nosniff',
    ...opts.extraHeaders,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // The file can disappear or become unreadable after stat (e.g. a ConfigMap update): end the
  // response instead of crashing on an unhandled stream error.
  await pipeline(createReadStream(file), res).catch(() => res.destroy());
  return true;
}
