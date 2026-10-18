// WebSocket client with automatic reconnection (exponential backoff + jitter).
// A reconnect joins again with a new peer id and rebuilds all state from the server snapshot.
// Fatal join errors (wrong passcode, room full, ...) stop the reconnect loop.

import { FATAL_ERRORS, PROTOCOL_VERSION, type ClientMsg, type ErrorCode, type ServerMsg } from '../../shared/protocol.ts';

type Hello = Omit<Extract<ClientMsg, { t: 'hello' }>, 't' | 'v'>;
export type ConnState = 'connecting' | 'open' | 'closed';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Messages that change room state carry the room epoch; senders pass them without it. */
export type StateMsg = Extract<ClientMsg, { e: number }>;
export type StateMsgInput = DistributiveOmit<StateMsg, 'e'>;

export class NetClient {
  state: ConnState = 'closed';
  rttMs: number | null = null;
  /** Room epoch from the latest welcome/config. */
  epoch = 0;
  onMessage: (msg: ServerMsg) => void = () => {};
  onState: (s: ConnState) => void = () => {};
  /** A join failed in a way retrying cannot fix. */
  onFatal: (code: ErrorCode, message?: string) => void = () => {};
  /** The auth proxy no longer lets us through (session expired): the page should reload. */
  onAuthExpired: () => void = () => {};

  private ws: WebSocket | null = null;
  private retryMs = 500;
  private stopped = false;
  private failedOpens = 0;
  private pingTimer: number | undefined;
  private readonly url: string;
  private hello: Hello;

  constructor(url: string, hello: Hello) {
    this.url = url;
    this.hello = hello;
  }

  /** Profile changes go through here so a reconnect re-sends the current values. */
  updateProfile(patch: Partial<Hello>): void {
    this.hello = { ...this.hello, ...patch };
    if (patch.device !== undefined || patch.space !== undefined) {
      this.send({ t: 'profile', device: this.hello.device, space: this.hello.space });
    }
    if (patch.voice !== undefined) this.send({ t: 'voice', state: patch.voice });
  }

  /** Reconnect with a passcode after `passcode-required` / `passcode-invalid`. */
  retryWithPasscode(passcode: string): void {
    this.hello = { ...this.hello, passcode };
    this.ws?.close();
    this.connect();
  }

  connect(): void {
    this.stopped = false;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.failedOpens = 0;
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
      if (msg.t === 'welcome' || msg.t === 'config') this.epoch = msg.epoch;
      if (msg.t === 'error' && FATAL_ERRORS.includes(msg.code)) {
        this.stopped = true;
        this.onFatal(msg.code, msg.message);
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState('closed');
      if (this.stopped) return;
      if (!opened && ++this.failedOpens >= 2) void this.checkAuth();
      const delay = this.retryMs * (0.75 + Math.random() * 0.5);
      window.setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
      this.retryMs = Math.min(this.retryMs * 2, 8000);
    };
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Send a state-changing message tagged with the current room epoch. */
  sendState(msg: StateMsgInput): void {
    this.send({ ...msg, e: this.epoch } as StateMsg);
  }

  /**
   * Browsers hide the HTTP status of a failed WebSocket handshake, so when connecting keeps failing
   * ask the HTTP API: a redirect (to the IdP) or 401/403 means the SSO session expired.
   */
  private async checkAuth(): Promise<void> {
    try {
      const res = await fetch('/api/config', { redirect: 'manual', cache: 'no-store' });
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
        this.stopped = true;
        this.onAuthExpired();
      }
    } catch {
      // network down: keep retrying
    }
  }

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }
}

export function defaultServerUrl(allowOverride: boolean): string {
  const override = allowOverride ? new URLSearchParams(location.search).get('server') : null;
  if (override) return override;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
