// 自動再接続つきの WebSocket クライアント。
// 再接続すると新しいピア id で入り直し、サーバーのスナップショットで状態を作り直す。

import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../../shared/protocol.ts';

type Hello = Omit<Extract<ClientMsg, { t: 'hello' }>, 't' | 'v'>;
export type ConnState = 'connecting' | 'open' | 'closed';

type Handler = (msg: ServerMsg) => void;

export class NetClient {
  state: ConnState = 'closed';
  rttMs: number | null = null;
  onMessage: Handler = () => {};
  onState: (s: ConnState) => void = () => {};

  private ws: WebSocket | null = null;
  private retryMs = 500;
  private stopped = false;
  private pingTimer: number | undefined;
  private readonly url: string;
  private hello: Hello;

  constructor(url: string, hello: Hello) {
    this.url = url;
    this.hello = hello;
  }

  /** 再接続時の hello にも反映されるよう、プロフィール変更 (音声の参加状態を含む) はここを通す。 */
  updateProfile(patch: Partial<Hello>): void {
    this.hello = { ...this.hello, ...patch };
    if (patch.device !== undefined || patch.space !== undefined) {
      this.send({ t: 'profile', device: this.hello.device, space: this.hello.space });
    }
    if (patch.voice !== undefined) this.send({ t: 'voice', state: patch.voice });
  }

  connect(): void {
    this.stopped = false;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.setState('open');
      this.send({ t: 'hello', v: PROTOCOL_VERSION, ...this.hello });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'pong') this.rttMs = performance.now() - msg.ts;
      this.onMessage(msg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState('closed');
      if (this.stopped) return;
      window.setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }
}

export function defaultServerUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
