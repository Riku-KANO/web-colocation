// Wires configuration, rooms, HTTP routes and the WebSocket server together.
// Used by the production entry point (main.ts), the Vite dev plugin and integration tests.

import type { EventEmitter } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { trustedHeadersProblem } from './auth.ts';
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
  helloTimeoutMs?: number;
  /** Address the app listens on; reloads that would trust identity headers on it are refused. */
  listenHost?: string;
  /** Serve /metrics on the main port too (default true; main.ts turns it off with a health port). */
  publicMetrics?: boolean;
}

export interface ServerApp {
  readonly registry: RoomRegistry;
  readonly log: Logger;
  readonly metrics: Metrics;
  readonly handler: Handler;
  readonly healthHandler: Handler;
  ready: boolean;
  attach(httpServer: EventEmitter): ColocationServer;
  /** Apply a reloaded configuration. */
  reload(loaded: LoadedConfig): void;
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
    handler: createHttpHandler({ registry, metrics, log, isReady: () => app.ready }, { staticDir: opts.staticDir ?? null, publicMetrics: opts.publicMetrics ?? true }),
    healthHandler: createHealthHandler({ registry, metrics, log, isReady: () => app.ready }),
    attach(httpServer) {
      const ws = attachColocationServer(httpServer, { registry, log, metrics }, { heartbeatMs: opts.heartbeatMs, helloTimeoutMs: opts.helloTimeoutMs });
      sockets.push(ws);
      return ws;
    },
    reload(loaded) {
      const unsafe = opts.listenHost !== undefined ? trustedHeadersProblem(loaded.config.auth, opts.listenHost) : null;
      if (unsafe) {
        log.error(`configuration change ignored: ${unsafe}`);
        return;
      }
      registry.reload(loaded);
    },
    async shutdown() {
      app.ready = false;
      clearInterval(sweep);
      loopDelay.disable();
      for (const s of sockets) s.drain();
      await registry.flush();
      registry.close();
      for (const s of sockets) s.close();
    },
  };
  // Remove stale ad-hoc rooms from storage now and then every hour.
  void registry.sweep();
  const sweep = setInterval(() => void registry.sweep(), 3600_000);
  sweep.unref();
  // Process health for capacity planning.
  const LOOP_SAMPLE_MS = 20;
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_MS });
  loopDelay.enable();
  metrics.gauge('process_cpu_seconds_total', 'User + system CPU time of the process', () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1e6;
  });
  metrics.gauge('process_resident_memory_bytes', 'Resident memory', () => process.memoryUsage().rss);
  metrics.gauge('colo_event_loop_lag_p99_ms', 'Event loop lag (beyond the sampling interval), 99th percentile since the last scrape', () => {
    // The histogram records whole sampling intervals; subtract the interval to get the lag.
    const v = Math.max(0, loopDelay.percentile(99) / 1e6 - LOOP_SAMPLE_MS);
    loopDelay.reset();
    return Math.round(v * 100) / 100;
  });
  metrics.gauge('colo_ws_open_connections', 'Open WebSocket connections', () => sockets.reduce((n, s) => n + s.connections, 0));
  return app;
}
