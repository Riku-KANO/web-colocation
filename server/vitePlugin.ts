// Runs the sync server inside `vite` / `vite preview`: /api routes as middleware and /ws on the
// same HTTP(S) server, so a headset opening https://<lan-ip>:5173 gets wss for free.

import type { Connect, Plugin } from 'vite';
import { createServerApp, type ServerApp } from './app.ts';
import { loadConfig } from './config/load.ts';
import { watchConfig } from './config/watch.ts';
import { createLogger } from './log.ts';

function middleware(app: ServerApp): Connect.NextHandleFunction {
  return (req, res, next) => {
    app
      .handler(req, res)
      .then((handled) => {
        if (!handled) next();
      })
      .catch(next);
  };
}

export function colocationServerPlugin(): Plugin {
  let app: ServerApp | null = null;
  let stopWatching = () => {};
  const create = (info: (m: string) => void) => {
    // COLO_CONFIG points at a YAML file; without it the built-in defaults are used.
    const path = process.env.COLO_CONFIG || null;
    const loaded = loadConfig(path, process.env);
    const log = createLogger((process.env.LOG_LEVEL as 'info') ?? 'info', 'pretty', (line) => info(line));
    const created = createServerApp({ loaded, log, env: process.env, staticDir: null });
    if (path) stopWatching = watchConfig(path, process.env, log, (next) => created.reload(next));
    app = created;
    return created;
  };
  return {
    name: 'colocation-server',
    configureServer(server) {
      const a = create((m) => server.config.logger.info(m, { timestamp: true }));
      server.middlewares.use(middleware(a));
      if (server.httpServer) {
        a.attach(server.httpServer);
        server.httpServer.on('close', () => {
          stopWatching();
          void a.shutdown();
        });
      }
    },
    configurePreviewServer(server) {
      const a = create((m) => server.config.logger.info(m, { timestamp: true }));
      server.middlewares.use(middleware(a));
      a.attach(server.httpServer);
      server.httpServer.on('close', () => void a.shutdown());
    },
    buildEnd() {
      void app?.shutdown();
    },
  };
}
