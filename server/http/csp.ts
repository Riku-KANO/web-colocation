// Content-Security-Policy for the app page, derived from the configuration so that model hosts,
// the logo and the WebXR input-profile CDN keep working. Enforced by default (`server.csp`); use
// report-only to find what a custom setup needs, the browser console lists the violations.

import type { AppConfig } from '../config/schema.ts';

const DEFAULT_PROFILES_ORIGIN = 'https://cdn.jsdelivr.net';

function originOf(url: string | undefined): string | null {
  if (!url || !/^https:\/\//.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCsp(config: AppConfig, host: string | undefined): string {
  const models = config.assets.allowedOrigins.map((o) => originOf(o)).filter((o): o is string => !!o);
  const profiles = config.xr.inputProfilesPath === 'none' ? null : (originOf(config.xr.inputProfilesPath) ?? (config.xr.inputProfilesPath ? null : DEFAULT_PROFILES_ORIGIN));
  const logo = originOf(config.branding.logo);
  const sockets = new Set<string>();
  if (host && /^[a-zA-Z0-9.:[\]-]+$/.test(host)) sockets.add(`wss://${host}`).add(`ws://${host}`);
  const pub = originOf(config.server.publicUrl);
  if (pub) sockets.add(pub.replace(/^https:/, 'wss:'));
  const list = (...items: Array<string | null | undefined>) => [...new Set(items.filter(Boolean))].join(' ');
  return [
    `default-src 'self'`,
    `script-src 'self' 'wasm-unsafe-eval'`,
    `style-src 'self'`,
    `img-src ${list("'self'", 'data:', 'blob:', logo, profiles, ...models)}`,
    // blob:/data: are not network destinations: three.js fetches embedded glTF images and buffers through them.
    `connect-src ${list("'self'", 'blob:', 'data:', ...sockets, profiles, ...models)}`,
    `media-src 'self' blob:`,
    `worker-src 'self' blob:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
  ].join('; ');
}

export function cspHeader(config: AppConfig, host: string | undefined): Record<string, string> {
  const mode = config.server.csp;
  if (mode === 'off') return {};
  const name = mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only';
  return { [name]: buildCsp(config, host) };
}
