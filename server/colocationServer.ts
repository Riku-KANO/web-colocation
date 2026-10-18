// WebSocket entry point. Rides on the `upgrade` event of any HTTP(S) server, so the same code
// runs inside the Vite dev server, the production server and tests.

import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_FATAL, CLOSE_RESTART, PROTOCOL_VERSION, type ServerMsg } from '../shared/protocol.ts';
import { parseClientMsg } from '../shared/validate.ts';
import { extractIdentity, type Identity } from './auth.ts';
import type { AppConfig } from './config/schema.ts';
import type { Logger } from './log.ts';
import type { Metrics } from './metrics.ts';
import type { Room } from './room.ts';
import type { RoomRegistry } from './rooms.ts';

export interface ServerContext {
  registry: RoomRegistry;
  log: Logger;
  metrics: Metrics;
}

export interface ColocationServerOptions {
  path?: string;
  heartbeatMs?: number;
}

export interface ColocationServer {
  /** Stop accepting connections and close existing ones with 1012 (clients reconnect). */
  drain(): void;
  close(): void;
  readonly connections: number;
}

const MAX_MESSAGES_PER_SECOND = 200;
/** Clients whose send buffer exceeds this are dropped (they recover from a snapshot on reconnect). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Browsers always send Origin; reject cross-site pages (CSWSH). Non-browser clients may omit it. */
export function isOriginAllowed(origin: string | undefined, host: string | undefined, server: AppConfig['server']): boolean {
  if (!origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (host && o.host === host) return true;
  if (server.publicUrl && new URL(server.publicUrl).origin === o.origin) return true;
  return server.allowedOrigins.some((a) => a === '*' || a.replace(/\/$/, '') === o.origin);
}

export function clientAddress(req: IncomingMessage, trustForwardedFor: boolean): string {
  if (trustForwardedFor) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachColocationServer(
  httpServer: EventEmitter,
  ctx: ServerContext,
  options: ColocationServerOptions = {},
): ColocationServer {
  const path = options.path ?? '/ws';
  const { registry, log, metrics } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  let draining = false;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) return; // leave other WebSockets (e.g. Vite HMR) alone
    const config = registry.config;
    if (draining) return reject(socket, 503, 'Service Unavailable');
    if (!isOriginAllowed(req.headers.origin, req.headers.host, config.server)) {
      metrics.inc('colo_ws_rejected_total', 'Rejected WebSocket upgrades', { reason: 'origin' });
      return reject(socket, 403, 'Forbidden');
    }
    const identity = extractIdentity(req.headers, config.auth);
    if (config.auth.mode === 'trusted-headers' && !identity) {
      metrics.inc('colo_ws_rejected_total', 'Rejected WebSocket upgrades', { reason: 'unauthenticated' });
      return reject(socket, 401, 'Unauthorized');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, identity));
  };
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, identity: Identity | null) => {
    const peerId = randomUUID().replaceAll('-', '').slice(0, 12);
    const clientKey = clientAddress(req, registry.config.server.trustForwardedFor);
    let room: Room | null = null;
    let joining = false;
    let closed = false;
    let windowStart = Date.now();
    let count = 0;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    metrics.inc('colo_ws_connections_total', 'Accepted WebSocket connections');

    const conn = {
      send(data: string) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          ws.terminate();
          return;
        }
        ws.send(data);
      },
    };
    const fail = (msg: Extract<ServerMsg, { t: 'error' }>) => {
      metrics.inc('colo_join_errors_total', 'Failed joins by reason', { code: msg.code });
      ws.send(JSON.stringify(msg));
      ws.close(CLOSE_FATAL, msg.code);
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MESSAGES_PER_SECOND) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseClientMsg(raw);
      if (!msg) return;
      if (room) {
        room.handle(peerId, msg);
        return;
      }
      if (joining || msg.t !== 'hello') return;
      if (msg.v !== PROTOCOL_VERSION) {
        fail({ t: 'error', code: 'protocol-mismatch', message: `server speaks protocol ${PROTOCOL_VERSION}` });
        return;
      }
      joining = true;
      registry
        .join(msg.room, peerId, conn, msg, identity, clientKey)
        .then((result) => {
          joining = false;
          if ('error' in result) {
            if (!closed) fail({ t: 'error', code: result.error });
            return;
          }
          if (closed) {
            registry.leave(result.room, peerId); // the socket went away while we were joining
            return;
          }
          room = result.room;
          log.info('peer joined', { room: room.id, peer: peerId, device: result.info.device, seat: result.info.seat, role: result.info.role });
        })
        .catch((e: unknown) => {
          joining = false;
          log.error('join failed', { error: String(e) });
          if (!closed) ws.close(1011, 'internal error');
        });
    });

    ws.on('close', () => {
      closed = true;
      if (!room) return;
      registry.leave(room, peerId);
      log.info('peer left', { room: room.id, peer: peerId });
    });
    ws.on('error', () => ws.terminate());
  });

  // Detect dead connections (e.g. a headset that went to sleep).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs ?? 15000);
  heartbeat.unref();

  return {
    get connections() {
      return wss.clients.size;
    },
    drain() {
      draining = true;
      for (const ws of wss.clients) ws.close(CLOSE_RESTART, 'server restarting');
    },
    close() {
      clearInterval(heartbeat);
      httpServer.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
