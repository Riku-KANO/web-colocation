// 本番用の単体サーバー: `npm run build` の成果物 (dist/) を配信し、/ws で同期する。
//   PORT=8787 node server/main.ts
// TLS_CERT / TLS_KEY (PEM ファイルのパス) を渡すと HTTPS で待ち受ける。
// 実運用では前段のリバースプロキシ (Caddy / nginx / Cloudflare Tunnel など) で TLS を終端してもよい。

import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachColocationServer } from './colocationServer.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: colo.rooms.size }));
    return;
  }
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found (did you run `npm run build`?)');
  }
}

const server =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? https.createServer(
        { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) },
        handler,
      )
    : http.createServer(handler);

const colo = attachColocationServer(server, { log: console.log });

server.listen(PORT, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`[colo] listening on ${scheme}://0.0.0.0:${PORT}`);
});
