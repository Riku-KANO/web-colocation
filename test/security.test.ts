import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractIdentity, isAllowed, isLoopbackHost } from '../server/auth.ts';
import { isOriginAllowed } from '../server/colocationServer.ts';
import { parseConfig } from '../server/config/load.ts';
import { decodePath } from '../server/http/static.ts';
import { hashPasscode, verifyPasscode } from '../server/passcode.ts';
import { FailureLimiter } from '../server/rateLimit.ts';
import { iceConfigFor, turnCredential } from '../server/turn.ts';

const auth = (raw: unknown = {}) => parseConfig({ auth: { mode: 'trusted-headers', ...(raw as object) } }).config.auth;

describe('trusted-header identity', () => {
  it('reads oauth2-proxy headers', () => {
    const id = extractIdentity(
      { 'x-forwarded-email': 'Alice@Acme.com', 'x-forwarded-user': 'alice-id', 'x-forwarded-groups': 'eng, xr ,', 'x-forwarded-preferred-username': 'Alice A.' },
      auth(),
    );
    expect(id).toEqual({ email: 'alice@acme.com', user: 'alice-id', groups: ['eng', 'xr'], name: 'Alice A.' });
  });

  it('falls back to the email local part for the display name', () => {
    expect(extractIdentity({ 'x-forwarded-email': 'bob@acme.com' }, auth())?.name).toBe('bob');
  });

  it('returns null when auth is off or the proxy sent nothing', () => {
    expect(extractIdentity({ 'x-forwarded-email': 'a@b.c' }, parseConfig({}).config.auth)).toBeNull();
    expect(extractIdentity({}, auth())).toBeNull();
  });

  it('supports custom header names', () => {
    const id = extractIdentity({ 'x-email': 'c@d.e' }, auth({ preset: 'custom', headers: { email: 'X-Email' } }));
    expect(id?.email).toBe('c@d.e');
  });

  it('applies room allow lists', () => {
    const id = { email: 'a@acme.com', user: null, groups: ['xr'], name: 'a' };
    const access = (o: object) => ({ allowedDomains: [], allowedUsers: [], allowedGroups: [], ...o });
    expect(isAllowed(id, undefined)).toBe(true);
    expect(isAllowed(id, access({ allowedDomains: ['ACME.com'] }))).toBe(true);
    expect(isAllowed(id, access({ allowedDomains: ['other.com'] }))).toBe(false);
    expect(isAllowed(id, access({ allowedGroups: ['xr'] }))).toBe(true);
    expect(isAllowed(null, access({ allowedUsers: ['a@acme.com'] }))).toBe(false);
  });

  it('knows loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('origin check (CSWSH)', () => {
  const server = parseConfig({ server: { publicUrl: 'https://xr.acme.com', allowedOrigins: ['https://portal.acme.com'] } }).config.server;
  it('allows same host, the public URL and configured origins only', () => {
    expect(isOriginAllowed(undefined, 'localhost:8080', server)).toBe(true); // non-browser client
    expect(isOriginAllowed('http://localhost:8080', 'localhost:8080', server)).toBe(true);
    expect(isOriginAllowed('https://xr.acme.com', 'internal:8080', server)).toBe(true);
    expect(isOriginAllowed('https://portal.acme.com', 'internal:8080', server)).toBe(true);
    expect(isOriginAllowed('https://evil.example', 'xr.acme.com', server)).toBe(false);
    expect(isOriginAllowed('not a url', 'xr.acme.com', server)).toBe(false);
  });
});

describe('passcodes', () => {
  it('hashes with a random salt and verifies', async () => {
    const h1 = await hashPasscode('open sesame', { N: 1024, r: 8, p: 1 });
    const h2 = await hashPasscode('open sesame', { N: 1024, r: 8, p: 1 });
    expect(h1).not.toBe(h2);
    expect(await verifyPasscode('open sesame', h1)).toBe(true);
    expect(await verifyPasscode('open sesam', h1)).toBe(false);
    expect(await verifyPasscode('x', 'garbage')).toBe(false);
  });

  it('limits repeated failures', () => {
    let now = 0;
    const lim = new FailureLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) lim.fail('k');
    expect(lim.blocked('k')).toBe(true);
    now = 2000;
    expect(lim.blocked('k')).toBe(false);
  });
});

describe('TURN REST credentials', () => {
  it('follow the coturn use-auth-secret scheme', () => {
    const { username, credential } = turnCredential('s3cret', 'peer1', 600, 1_000_000_000_000);
    expect(username).toBe('1000000600:peer1');
    expect(credential).toBe(createHmac('sha1', 's3cret').update(username).digest('base64'));
  });

  it('are only added when the secret is configured', () => {
    const voice = parseConfig({ voice: { turn: { urls: ['turn:turn.acme.com:3478'], secretEnv: 'T' } } }).config.voice;
    expect(iceConfigFor(voice, 'p', {}).ttl).toBe(0);
    const ice = iceConfigFor(voice, 'p', { T: 'x' });
    expect(ice.ttl).toBe(3600);
    expect(ice.iceServers.at(-1)).toMatchObject({ urls: ['turn:turn.acme.com:3478'] });
  });
});

describe('path decoding', () => {
  it('rejects malformed escapes instead of throwing', () => {
    expect(decodePath('/%')).toBeNull();
    expect(decodePath('/a%00b')).toBeNull();
    expect(decodePath('/%E3%81%82')).toBe('/あ');
  });
});
