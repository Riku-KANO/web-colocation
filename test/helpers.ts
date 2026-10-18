// Shared test utilities: fake connections, room configs and a real HTTP + WebSocket server.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol.ts';
import type { RoomConfig } from '../shared/roomConfig.ts';
import { createServerApp, type ServerApp, type ServerAppOptions } from '../server/app.ts';
import { parseConfig } from '../server/config/load.ts';
import { TemplateRegistry, buildRoomConfig } from '../server/config/resolve.ts';
import { silentLogger } from '../server/log.ts';
import type { JoinRequest } from '../server/room.ts';

export type Hello = Extract<ClientMsg, { t: 'hello' }>;

export function roomConfig(id = 'r', template = 'standard'): RoomConfig {
  return buildRoomConfig(id, id, new TemplateRegistry().get(template)!);
}

export const hello = (name: string, extra: Partial<Hello> = {}): Hello => ({
  t: 'hello',
  v: PROTOCOL_VERSION,
  room: 'r',
  name,
  color: '#112233',
  device: 'desktop',
  space: '',
  ...extra,
});

export const join = (name: string, extra: Partial<JoinRequest> = {}): JoinRequest => ({
  hello: hello(name),
  name,
  verified: false,
  configuredHost: false,
  ...extra,
});

export const pose = (x: number) => ({
  p: [x, 0.05, 0] as [number, number, number],
  q: [0, 0, 0, 1] as [number, number, number, number],
});

/** Collects messages sent to one participant. */
export class FakePeer {
  readonly inbox: ServerMsg[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  send(data: string) {
    this.inbox.push(JSON.parse(data) as ServerMsg);
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
  all<T extends ServerMsg['t']>(t: T): Array<Extract<ServerMsg, { t: T }>> {
    return this.inbox.filter((m) => m.t === t) as Array<Extract<ServerMsg, { t: T }>>;
  }
  clear() {
    this.inbox.length = 0;
  }
}

export interface RunningServer {
  app: ServerApp;
  http: http.Server;
  base: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** Start the real HTTP + WebSocket server on a random port. */
export async function startServer(rawConfig: unknown = {}, opts: Partial<ServerAppOptions> = {}): Promise<RunningServer> {
  const app = createServerApp({ loaded: parseConfig(rawConfig), log: silentLogger, heartbeatMs: 60_000, ...opts });
  const server = http.createServer((req, res) => {
    void app.handler(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  app.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    http: server,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await app.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A protocol client over a real WebSocket. */
export class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMsg[] = [];
  closeCode: number | null = null;
  private waiters: Array<() => void> = [];

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (d) => {
      this.inbox.push(JSON.parse(d.toString()) as ServerMsg);
      this.wake();
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
      this.wake();
    });
    this.ws.on('error', () => this.wake());
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once('error', reject);
    });
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }

  get epoch(): number {
    const m = [...this.inbox].reverse().find((x) => x.t === 'welcome' || x.t === 'config') as { epoch: number } | undefined;
    return m?.epoch ?? 1;
  }

  async waitFor<T extends ServerMsg['t']>(
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.inbox.find((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (found) return found as Extract<ServerMsg, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}; got ${this.inbox.map((m) => m.t).join(',')}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  async closed(timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('timeout waiting for close');
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return this.closeCode;
  }

  close() {
    this.ws.terminate();
  }
}

/** Open a client and join a room; resolves with the welcome message. */
export async function joinRoom(wsUrl: string, name: string, extra: Partial<Hello> = {}, headers: Record<string, string> = {}) {
  const c = new Client(wsUrl, headers);
  await c.opened();
  c.send(hello(name, extra));
  const welcome = await c.waitFor('welcome');
  return { c, self: welcome.self, welcome };
}
