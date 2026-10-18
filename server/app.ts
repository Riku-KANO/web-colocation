// Wires configuration, rooms, HTTP routes and the WebSocket server together.
// Used by the production entry point (main.ts), the Vite dev plugin and integration tests.

import type { EventEmitter } from 'node:events';
import { attachColocationServer, type ColocationServer } from './colocationServer.ts';
import type { LoadedConfig } from './config/load.ts';
import { createHealthHandler, createHttpHandler, type Handler } from './http/handler.ts';
import { createLogger, type Logger } from './log.ts';
import { Metrics } from './metrics.ts';
import { RoomRegistry } from './rooms.ts';
import type { Store } from './store.ts';

export interface ServerAppOptions {
  loaded: LoadedConfig;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  store?: Store;
  staticDir?: string | null;
  emptyRoomTtlMs?: number;
  saveDelayMs?: number;
  heartbeatMs?: number;
}

export interface ServerApp {
  readonly registry: RoomRegistry;
  readonly log: Logger;
  readonly metrics: Metrics;
  readonly handler: Handler;
  readonly healthHandler: Handler;
  ready: boolean;
  attach(httpServer: EventEmitter): ColocationServer;
  /** Graceful stop: not ready → stop upgrades → close sockets with 1012 → persist state. */
  shutdown(): Promise<void>;
}

export function createServerApp(opts: ServerAppOptions): ServerApp {
  const log = opts.log ?? createLogger();
  const metrics = new Metrics();
  const registry = new RoomRegistry({
    loaded: opts.loaded,
    log,
    metrics,
    env: opts.env,
    store: opts.store,
    emptyRoomTtlMs: opts.emptyRoomTtlMs,
    saveDelayMs: opts.saveDelayMs,
  });
  const sockets: ColocationServer[] = [];
  const app: ServerApp = {
    registry,
    log,
    metrics,
    ready: true,
    handler: createHttpHandler({ registry, metrics, log, isReady: () => app.ready }, { staticDir: opts.staticDir ?? null }),
    healthHandler: createHealthHandler({ registry, metrics, log, isReady: () => app.ready }),
    attach(httpServer) {
      const ws = attachColocationServer(httpServer, { registry, log, metrics }, { heartbeatMs: opts.heartbeatMs });
      sockets.push(ws);
      return ws;
    },
    async shutdown() {
      app.ready = false;
      for (const s of sockets) s.drain();
      await registry.flush();
      registry.close();
      for (const s of sockets) s.close();
    },
  };
  metrics.gauge('colo_ws_open_connections', 'Open WebSocket connections', () => sockets.reduce((n, s) => n + s.connections, 0));
  return app;
}
