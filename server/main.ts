// Production entry point: serves dist/ + /api + /ws, and health endpoints on HEALTH_PORT.
//
//   COLO_CONFIG=/config/config.yaml PORT=8080 HEALTH_PORT=8081 node server/main.ts
//
// TLS is normally terminated by the ingress / load balancer. For a standalone HTTPS server pass
// TLS_CERT and TLS_KEY (PEM file paths).

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createServerApp } from './app.ts';
import { isLoopbackHost } from './auth.ts';
import { loadConfig, runtimeFromEnv } from './config/load.ts';
import { createFileStore } from './fileStore.ts';
import type { Handler } from './http/handler.ts';
import { createLogger } from './log.ts';
import { MemoryStore } from './store.ts';

const bootLog = createLogger('info', process.env.LOG_FORMAT === 'pretty' ? 'pretty' : 'json');

function fatal(message: string): never {
  bootLog.error(message);
  process.exit(1);
}

let runtime;
let loaded;
try {
  runtime = runtimeFromEnv(process.env);
  loaded = loadConfig(runtime.configPath, process.env);
} catch (e) {
  fatal((e as Error).message);
}
const log = createLogger(runtime.logLevel, runtime.logFormat);
const config = loaded.config;

if (config.auth.mode === 'trusted-headers' && !isLoopbackHost(runtime.host) && !config.auth.allowNonLoopback) {
  fatal(
    `auth.mode is "trusted-headers" but HOST=${runtime.host} is not a loopback address. ` +
      'Run the app behind the auth proxy on 127.0.0.1 (the Helm chart does this), or set auth.allowNonLoopback: true if the network guarantees that only the proxy can reach it.',
  );
}

const store = config.storage.driver === 'file' ? await createFileStore(config.storage.dir) : new MemoryStore();
const app = createServerApp({ loaded, log, env: process.env, store, staticDir: runtime.staticDir });

const serve = (handler: Handler) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  handler(req, res)
    .then((handled) => {
      if (!handled && !res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    })
    .catch((e: unknown) => {
      log.error('request failed', { url: req.url, error: String(e) });
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
};

const server =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? https.createServer({ cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }, serve(app.handler))
    : http.createServer(serve(app.handler));
app.attach(server);
server.listen(runtime.port, runtime.host, () => {
  log.info('listening', {
    url: `${server instanceof https.Server ? 'https' : 'http'}://${runtime.host}:${runtime.port}`,
    config: loaded.source ?? '(defaults)',
    auth: config.auth.mode,
    storage: store.kind,
  });
});

const health = runtime.healthPort !== null ? http.createServer(serve(app.healthHandler)) : null;
health?.listen(runtime.healthPort!, '0.0.0.0', () => log.info('health endpoints listening', { port: runtime.healthPort }));

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await app.shutdown();
  server.close();
  health?.close();
  log.info('bye');
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: String(e) }));
