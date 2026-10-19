// Identity from a trusted authenticating proxy (oauth2-proxy by default).
//
// The app never authenticates users itself. In `trusted-headers` mode it must only be reachable
// through the proxy — the Helm chart runs oauth2-proxy as a sidecar and binds the app to
// 127.0.0.1 — otherwise anyone could forge the headers. main.ts refuses to start in that mode
// on a non-loopback address unless `auth.allowNonLoopback` is set.

import type { IncomingHttpHeaders } from 'node:http';
import type { AppConfig } from './config/schema.ts';

export interface Identity {
  user: string | null;
  email: string | null;
  groups: string[];
  /** Display name derived from the identity. */
  name: string;
}

export interface HeaderNames {
  user: string;
  email: string;
  groups: string;
  name: string | null;
}

export function headerNames(auth: AppConfig['auth']): HeaderNames {
  if (auth.preset === 'oauth2-proxy') {
    return {
      user: 'x-forwarded-user',
      email: 'x-forwarded-email',
      groups: 'x-forwarded-groups',
      name: 'x-forwarded-preferred-username',
    };
  }
  return {
    user: (auth.headers.user ?? 'x-forwarded-user').toLowerCase(),
    email: (auth.headers.email ?? 'x-forwarded-email').toLowerCase(),
    groups: (auth.headers.groups ?? 'x-forwarded-groups').toLowerCase(),
    name: auth.headers.name?.toLowerCase() ?? null,
  };
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t.slice(0, 254) : null;
}

/** null when auth is off or the proxy did not send an identity. */
export function extractIdentity(headers: IncomingHttpHeaders, auth: AppConfig['auth']): Identity | null {
  if (auth.mode !== 'trusted-headers') return null;
  const h = headerNames(auth);
  const email = header(headers, h.email)?.toLowerCase() ?? null;
  const user = header(headers, h.user);
  if (!email && !user) return null;
  const groups = (header(headers, h.groups) ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 100);
  // OIDC `sub` values (X-Forwarded-User) are often opaque ids, and proxies fall back to them for
  // the preferred username when the IdP sends none — so only trust a name that differs from it.
  const preferred = h.name ? header(headers, h.name) : null;
  const readable = preferred && preferred !== user ? preferred : null;
  const name = (readable ?? email?.split('@')[0] ?? user ?? 'user').slice(0, 32);
  return { user, email, groups, name };
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

/**
 * Identity headers can be trusted only if nothing but the auth proxy can reach the app. Returns
 * why `config` is unsafe to run on `host`, or null. Checked at startup and on every reload.
 */
export function trustedHeadersProblem(auth: AppConfig['auth'], host: string): string | null {
  if (auth.mode !== 'trusted-headers' || isLoopbackHost(host) || auth.allowNonLoopback) return null;
  return (
    `auth.mode is "trusted-headers" but the app listens on ${host}, which is not a loopback address. ` +
    'Run the app behind the auth proxy on 127.0.0.1 (the Helm chart does this), or set auth.allowNonLoopback: true if the network guarantees that only the proxy can reach it.'
  );
}

const norm = (s: string) => s.trim().toLowerCase();

export function isAdmin(identity: Identity | null, auth: AppConfig['auth']): boolean {
  const email = identity?.email;
  return !!email && auth.admins.some((a) => norm(a) === email);
}

/** Room-level allow lists. An empty/absent access block allows everyone (who passed the proxy). */
export function isAllowed(
  identity: Identity | null,
  access: { allowedDomains: string[]; allowedUsers: string[]; allowedGroups: string[] } | undefined,
): boolean {
  if (!access) return true;
  const { allowedDomains, allowedUsers, allowedGroups } = access;
  if (!allowedDomains.length && !allowedUsers.length && !allowedGroups.length) return true;
  if (!identity) return false;
  const email = identity.email ?? '';
  // The domain follows the last @ ("a@acme.com@evil.example" is not at acme.com).
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
  if (domain && allowedDomains.some((d) => norm(d) === domain)) return true;
  if (allowedUsers.some((u) => norm(u) === email || (identity.user && norm(u) === norm(identity.user)))) return true;
  return identity.groups.some((g) => allowedGroups.includes(g));
}
