// End-to-end SSO check: log in through oauth2-proxy + dex (static user), then join a room over
// WebSocket with the session cookie and verify the app sees the SSO identity.
//
//   node test/e2e/sso-check.mjs <app base URL> [email] [password]
//
// Runs anywhere the URLs in the redirects resolve (inside the kind cluster, or on the host for
// the docker compose setup). Needs the `ws` package (available in the app image).

import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:4180';
const email = process.argv[3] ?? 'alice@example.com';
const password = process.argv[4] ?? 'password';
const jar = new Map(); // host -> Map(name -> value)

function storeCookies(url, res) {
  const host = new URL(url).host;
  const cookies = jar.get(host) ?? new Map();
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  jar.set(host, cookies);
}
const cookieHeader = (url) => [...(jar.get(new URL(url).host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; ');

async function go(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: cookieHeader(url) } });
  storeCookies(url, res);
  return res;
}

/** Follow redirects (absolute or relative) until a non-redirect response. */
async function follow(url, init) {
  let res = await go(url, init);
  let current = url;
  for (let i = 0; i < 15 && res.status >= 300 && res.status < 400; i++) {
    current = new URL(res.headers.get('location'), current).href;
    res = await go(current);
  }
  return { res, url: current };
}

function fail(msg) {
  console.error(`SSO CHECK FAILED: ${msg}`);
  process.exit(1);
}

// 1. Unauthenticated requests are redirected to the IdP (or the proxy's sign-in page).
const first = await go(`${base}/api/config`);
if (first.status !== 302 && first.status !== 401 && first.status !== 403) fail(`expected a redirect for an anonymous request, got ${first.status}`);
console.log(`anonymous /api/config -> ${first.status}`);

// 2. Start the login and reach dex's password form.
const { res: loginPage, url: loginUrl } = await follow(`${base}/oauth2/start?rd=%2F`);
const html = await loginPage.text();
const action = html.match(/<form[^>]*action="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&');
if (!action) fail(`no login form at ${loginUrl} (status ${loginPage.status})`);

// 3. Submit the credentials; dex redirects back to /oauth2/callback which sets the session cookie.
const { res: afterLogin, url: landed } = await follow(new URL(action, loginUrl).href, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ login: email, password }).toString(),
});
console.log(`after login: ${afterLogin.status} ${landed}`);

// 3b. Some IdP setups show a consent ("approval") page: approve it.
if (afterLogin.status === 200 && /approval/.test(landed)) {
  const page = await afterLogin.text();
  const form = page.match(/<form[^>]*>([\s\S]*?)<\/form>/i)?.[0] ?? '';
  const target = form.match(/action="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&') ?? landed;
  const fields = new URLSearchParams();
  for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1];
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? '';
    if (name) fields.set(name, value.replaceAll('&amp;', '&'));
  }
  fields.set('approval', 'approve');
  const { res, url } = await follow(new URL(target, landed).href, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields.toString(),
  });
  console.log(`after approval: ${res.status} ${url}`);
}

// 4. The app now sees the identity.
const cfgRes = await go(`${base}/api/config`);
if (cfgRes.status !== 200) fail(`/api/config after login returned ${cfgRes.status}`);
const cfg = await cfgRes.json();
if (cfg.auth?.identity?.email !== email) fail(`identity not passed through: ${JSON.stringify(cfg.auth)}`);
console.log(`identity: ${JSON.stringify(cfg.auth.identity)}`);

// 5. Join a room over WebSocket with the session cookie.
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const welcome = await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl, { headers: { cookie: cookieHeader(base), origin: base } });
  const timer = setTimeout(() => reject(new Error('timeout waiting for welcome')), 10000);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: cfg.protocol, room: 'sso-check', name: 'ignored', color: '#123456', device: 'desktop', space: '' })));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'welcome') {
      clearTimeout(timer);
      ws.close();
      resolve(m);
    } else if (m.t === 'error') reject(new Error(`join error ${m.code}`));
  });
  ws.on('unexpected-response', (_req, res) => reject(new Error(`WebSocket upgrade rejected: HTTP ${res.statusCode}`)));
  ws.on('error', reject);
}).catch((e) => fail(e.message));
if (!welcome.self.verified) fail('peer is not marked as verified');
console.log(`joined as ${welcome.self.name} (verified=${welcome.self.verified}, role=${welcome.self.role})`);

// 6. A WebSocket without the cookie is refused by the proxy.
const anonymous = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl, { headers: { origin: base } });
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
  ws.on('open', () => {
    ws.close();
    resolve(101);
  });
  ws.on('error', () => resolve('error'));
});
if (anonymous === 101) fail('anonymous WebSocket was accepted');
console.log(`anonymous WebSocket -> ${anonymous}`);
console.log('SSO CHECK OK');
process.exit(0);
