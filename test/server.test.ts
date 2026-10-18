// 実際の HTTP + WebSocket サーバーを立て、2 クライアントで同期を確認する結合テスト。

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg, type VoiceState } from '../shared/protocol.ts';
import { attachColocationServer, type ColocationServer } from '../server/colocationServer.ts';

let server: http.Server | null = null;
let colo: ColocationServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets.length = 0;
  colo?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

async function startServer(): Promise<string> {
  server = http.createServer();
  colo = attachColocationServer(server);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
}

class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMsg[] = [];
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    sockets.push(this.ws);
    this.ws.on('message', (d) => {
      this.inbox.push(JSON.parse(d.toString()) as ServerMsg);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  opened() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }

  async waitFor<T extends ServerMsg['t']>(
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const found = this.inbox.find((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (found) return found as Extract<ServerMsg, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
}

async function join(url: string, name: string, room = 'it', voice: VoiceState = 'off') {
  const c = new Client(url);
  await c.opened();
  c.send({ t: 'hello', v: PROTOCOL_VERSION, room, name, color: '#123456', device: 'desktop', space: '', voice });
  const welcome = await c.waitFor('welcome');
  return { c, self: welcome.self };
}

describe('colocation server (WebSocket)', () => {
  it('A が動かした物が B に届き、離すと確定姿勢が共有される', async () => {
    const url = await startServer();
    const a = await join(url, 'Alice');
    const b = await join(url, 'Bob');
    await a.c.waitFor('peer-join', (m) => m.peer.id === b.self.id);

    a.c.send({ t: 'grab', id: 'cube' });
    await b.c.waitFor('owner', (m) => m.id === 'cube' && m.owner === a.self.id);
    a.c.send({ t: 'move', id: 'cube', pose: { p: [0.42, 0.2, 0.1], q: [0, 0, 0, 1] } });
    const mv = await b.c.waitFor('move', (m) => m.id === 'cube');
    expect(mv.pose.p).toEqual([0.42, 0.2, 0.1]);

    a.c.send({ t: 'release', id: 'cube', pose: { p: [0.5, 0.05, 0.1], q: [0, 0, 0, 1] } });
    const rel = await b.c.waitFor('owner', (m) => m.id === 'cube' && m.owner === null);
    expect(rel.pose?.p).toEqual([0.5, 0.05, 0.1]);

    // 途中参加の C には最新状態がスナップショットで届く
    const c = await join(url, 'Carol');
    const w = c.c.inbox.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.snapshot.objects.find((o) => o.id === 'cube')?.pose.p).toEqual([0.5, 0.05, 0.1]);
    expect(w.self.seat).toBe(2);
  });

  it('別のルームには届かない', async () => {
    const url = await startServer();
    const a = await join(url, 'Alice', 'room-1');
    const b = await join(url, 'Bob', 'room-2');
    a.c.send({ t: 'grab', id: 'cube' });
    await a.c.waitFor('owner');
    await new Promise((r) => setTimeout(r, 100));
    expect(b.c.inbox.some((m) => m.t === 'owner')).toBe(false);
    expect(colo!.rooms.size).toBe(2);
  });

  it('切断したら所有権が解放され、残った人に peer-leave が届く', async () => {
    const url = await startServer();
    const a = await join(url, 'Alice');
    const b = await join(url, 'Bob');
    a.c.send({ t: 'grab', id: 'torus' });
    await b.c.waitFor('owner', (m) => m.owner === a.self.id);
    a.c.ws.close();
    await b.c.waitFor('peer-leave', (m) => m.id === a.self.id);
    await b.c.waitFor('owner', (m) => m.id === 'torus' && m.owner === null);
  });

  it('WebRTC のシグナリングが音声参加者の間で宛先にだけ中継される', async () => {
    const url = await startServer();
    const a = await join(url, 'Alice', 'it', 'on');
    const b = await join(url, 'Bob');
    const c = await join(url, 'Carol'); // 音声に参加しない
    expect(b.c.inbox.find((m) => m.t === 'welcome')?.snapshot.peers.find((p) => p.id === a.self.id)?.voice).toBe('on');

    b.c.send({ t: 'voice', state: 'muted' });
    await a.c.waitFor('peer-update', (m) => m.peer.id === b.self.id && m.peer.voice === 'muted');

    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
    const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
    a.c.send({ t: 'rtc-offer', to: b.self.id, sdp });
    a.c.send({ t: 'rtc-ice', to: b.self.id, candidate });
    a.c.send({ t: 'rtc-offer', to: c.self.id, sdp }); // 不参加の人へは届かない
    expect(await b.c.waitFor('rtc-offer')).toEqual({ t: 'rtc-offer', from: a.self.id, sdp });
    expect(await b.c.waitFor('rtc-ice')).toEqual({ t: 'rtc-ice', from: a.self.id, candidate });
    b.c.send({ t: 'rtc-answer', to: a.self.id, sdp });
    expect(await a.c.waitFor('rtc-answer')).toEqual({ t: 'rtc-answer', from: b.self.id, sdp });

    // B が切断すると A に peer-leave が届き、以後 B 宛ては捨てられる (A は接続を破棄して作り直す)
    b.c.ws.close();
    await a.c.waitFor('peer-leave', (m) => m.id === b.self.id);
    a.c.send({ t: 'rtc-offer', to: b.self.id, sdp });
    // 再接続した B (新しい id) とは張り直せる
    const b2 = await join(url, 'Bob', 'it', 'muted');
    await a.c.waitFor('peer-join', (m) => m.peer.id === b2.self.id && m.peer.voice === 'muted');
    a.c.send({ t: 'rtc-offer', to: b2.self.id, sdp });
    expect(await b2.c.waitFor('rtc-offer')).toMatchObject({ from: a.self.id });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.c.inbox.some((m) => m.t.startsWith('rtc-'))).toBe(false);
    expect(b2.c.inbox.filter((m) => m.t === 'rtc-offer')).toHaveLength(1);
  });

  it('プロトコルのバージョン違いは参加させない', async () => {
    const url = await startServer();
    const c = new Client(url);
    await c.opened();
    const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    c.send({ t: 'hello', v: 999, room: 'x', name: 'old', color: '#000000', device: 'desktop', space: '' });
    expect(await closed).toBe(4000);
  });
});
