// WebSocket の受け口。HTTP(S) サーバーの upgrade に相乗りするので、
// Vite 開発サーバーにも単体の本番サーバーにも同じコードで載せられる。

import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { parseClientMsg } from '../shared/validate.ts';
import { Room } from './room.ts';

export interface ColocationServerOptions {
  path?: string;
  log?: (message: string) => void;
  /** 全員退出後、ルーム状態を保持する時間。 */
  emptyRoomTtlMs?: number;
  heartbeatMs?: number;
}

export interface ColocationServer {
  readonly rooms: ReadonlyMap<string, Room>;
  close(): void;
}

const MAX_MESSAGES_PER_SECOND = 200;
/** 送信待ちがこれを超えたクライアントは切断する (再接続でスナップショットから復帰させる)。 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function attachColocationServer(
  httpServer: EventEmitter,
  options: ColocationServerOptions = {},
): ColocationServer {
  const path = options.path ?? '/ws';
  const log = options.log ?? (() => {});
  const emptyRoomTtlMs = options.emptyRoomTtlMs ?? 10 * 60 * 1000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const rooms = new Map<string, Room>();
  const cleanupTimers = new Map<string, NodeJS.Timeout>();
  const alive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) return; // Vite HMR など他の WebSocket には触らない
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  httpServer.on('upgrade', onUpgrade);

  function getRoom(id: string): Room {
    const timer = cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      cleanupTimers.delete(id);
    }
    let room = rooms.get(id);
    if (!room) {
      room = new Room(id);
      rooms.set(id, room);
      log(`[colo] room created: ${id}`);
    }
    return room;
  }

  function scheduleCleanup(room: Room) {
    if (room.peerCount > 0 || cleanupTimers.has(room.id)) return;
    const timer = setTimeout(() => {
      cleanupTimers.delete(room.id);
      if (room.peerCount === 0) {
        rooms.delete(room.id);
        log(`[colo] room disposed: ${room.id}`);
      }
    }, emptyRoomTtlMs);
    timer.unref();
    cleanupTimers.set(room.id, timer);
  }

  wss.on('connection', (ws: WebSocket) => {
    const peerId = randomUUID().replaceAll('-', '').slice(0, 10);
    let room: Room | null = null;
    let windowStart = Date.now();
    let count = 0;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

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

      if (!room) {
        if (msg.t !== 'hello') return;
        if (msg.v !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ t: 'error', message: `protocol version mismatch (server=${PROTOCOL_VERSION})` }));
          ws.close(4000, 'protocol version mismatch');
          return;
        }
        room = getRoom(msg.room);
        const info = room.join(peerId, conn, msg);
        log(`[colo] ${info.name} (${peerId}, ${info.device}) joined ${room.id} seat=${info.seat}`);
        return;
      }
      room.handle(peerId, msg);
    });

    ws.on('close', () => {
      if (!room) return;
      room.leave(peerId);
      log(`[colo] ${peerId} left ${room.id}`);
      scheduleCleanup(room);
    });
    ws.on('error', () => ws.terminate());
  });

  // 応答のない接続 (ヘッドセットのスリープ等) を検出して掃除する。
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
    rooms,
    close() {
      clearInterval(heartbeat);
      for (const t of cleanupTimers.values()) clearTimeout(t);
      httpServer.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
