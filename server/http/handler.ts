// HTTP routes shared by the production server and the Vite dev middleware.
//
//   GET /api/config          deployment settings for the browser (branding, rooms, identity)
//   GET /healthz /readyz      liveness / readiness (also on the separate health port)
//   GET /metrics              Prometheus metrics (also on the health port)
//   GET /room-assets/*        operator-provided files (logos, GLB models) from assets.dir
//   GET /*                    the built SPA (production only)

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { extractIdentity } from '../auth.ts';
import type { Logger } from '../log.ts';
import type { Metrics } from '../metrics.ts';
import type { RoomRegistry } from '../rooms.ts';
import { cspHeader } from './csp.ts';
import { decodePath, resolveInside, sendFile } from './static.ts';

export interface HttpContext {
  registry: RoomRegistry;
  metrics: Metrics;
  log: Logger;
  isReady(): boolean;
}

export interface HandlerOptions {
  /** Directory with the built SPA; null in development (Vite serves it). */
  staticDir: string | null;
  /** Also serve /metrics here (off when a separate health port serves it). */
  publicMetrics?: boolean;
}

/** Operator files can be anything (SVG, HTML...): never let them run scripts in our origin. */
const ASSET_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** Security headers for HTML documents (the CSP comes from csp.ts). */
export function documentHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    // Also covered by CSP frame-ancestors, which browsers ignore in report-only mode.
    'x-frame-options': 'SAMEORIGIN',
    'permissions-policy': 'xr-spatial-tracking=(self), microphone=(self), camera=(), geolocation=()',
  };
}

function json(res: ServerResponse, status: number, body: unknown): true {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
  return true;
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): true {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

/** /healthz, /readyz, /metrics — never reads identity headers, safe to expose on 0.0.0.0. */
export function createHealthHandler(ctx: HttpContext): Handler {
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz') return text(res, 200, 'ok\n');
    if (path === '/readyz') return ctx.isReady() ? text(res, 200, 'ready\n') : text(res, 503, 'not ready\n');
    if (path === '/metrics') return text(res, 200, ctx.metrics.render(), 'text/plain; version=0.0.4');
    return false;
  };
}

export function createHttpHandler(ctx: HttpContext, opts: HandlerOptions): Handler {
  const health = createHealthHandler(ctx);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodePath(url.pathname);
    if (path === null) return text(res, 400, 'bad request\n');
    if (path === '/metrics' && !opts.publicMetrics) return text(res, 404, 'not found\n');
    if (await health(req, res)) return true;
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (path === '/api/config') {
      if (!isRead) return text(res, 405, 'method not allowed\n');
      const config = ctx.registry.config;
      return json(res, 200, ctx.registry.clientConfig(extractIdentity(req.headers, config.auth)));
    }

    if (path.startsWith('/room-assets/')) {
      if (!isRead) return text(res, 405, 'method not allowed\n');
      const assets = ctx.registry.config.assets;
      const file = assets.dir ? await resolveInside(assets.dir, path.slice('/room-assets/'.length)) : null;
      const extra: Record<string, string> = { 'access-control-allow-origin': '*', 'content-security-policy': ASSET_CSP };
      if (file && (await sendFile(req, res, file, { cacheControl: 'public, max-age=300', extraHeaders: extra, maxBytes: assets.maxModelBytes }))) {
        return true;
      }
      return text(res, 404, 'not found\n');
    }

    if (!opts.staticDir || !isRead) return false;
    const isAsset = /\.[a-z0-9]+$/i.test(path) && path !== '/index.html';
    if (isAsset) {
      const file = await resolveInside(opts.staticDir, path);
      const immutable = path.startsWith('/assets/');
      if (file && (await sendFile(req, res, file, { cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' }))) {
        return true;
      }
      return text(res, 404, 'not found\n');
    }
    // SPA routes all serve index.html.
    const index = join(opts.staticDir, 'index.html');
    const headers = { ...documentHeaders(), ...cspHeader(ctx.registry.config, req.headers.host) };
    if (await sendFile(req, res, index, { cacheControl: 'no-cache', extraHeaders: headers })) return true;
    return text(res, 404, 'not found (did you run `npm run build`?)\n');
  };
}
