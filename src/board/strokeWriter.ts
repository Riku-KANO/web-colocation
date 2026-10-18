// 自分が書いているストロークを、ローカルに即描画しつつ間引き・まとめ送信する。

import type { ClientMsg } from '../../shared/protocol.ts';
import type { Whiteboard } from './whiteboard.ts';

const FLUSH_INTERVAL_MS = 40;
/** これより短い移動 (正規化座標) は点を追加しない。ボード幅 1.2m で約 2mm。 */
const MIN_STEP = 0.0016;

const q = (x: number) => Math.round(x * 1e4) / 1e4;

export class StrokeHandle {
  readonly id: string;
  private lastU: number;
  private lastV: number;
  pending: number[] = [];
  ended = false;
  private readonly writer: StrokeWriter;

  constructor(writer: StrokeWriter, id: string, u: number, v: number) {
    this.writer = writer;
    this.id = id;
    this.lastU = u;
    this.lastV = v;
  }

  add(u: number, v: number): void {
    if (this.ended) return;
    if (Math.hypot(u - this.lastU, v - this.lastV) < MIN_STEP) return;
    this.lastU = u;
    this.lastV = v;
    const pts = [q(u), q(v)];
    this.pending.push(...pts);
    this.writer.board.appendPoints(this.id, pts);
  }

  end(): void {
    if (this.ended) return;
    this.writer.flush(this);
    this.ended = true;
    this.writer.board.endStroke(this.id);
    this.writer.send({ t: 'stroke-end', id: this.id });
    this.writer.forget(this);
  }
}

export class StrokeWriter {
  readonly board: Whiteboard;
  readonly send: (msg: ClientMsg) => void;
  private readonly selfId: () => string | null;
  private readonly active = new Set<StrokeHandle>();
  private counter = 0;
  private lastFlush = 0;

  constructor(board: Whiteboard, send: (msg: ClientMsg) => void, selfId: () => string | null) {
    this.board = board;
    this.send = send;
    this.selfId = selfId;
  }

  begin(color: string, width: number, u: number, v: number): StrokeHandle | null {
    const self = this.selfId();
    if (!self) return null;
    const id = `${self}-${++this.counter}`;
    const pts = [q(u), q(v)];
    this.board.addStroke({ id, board: this.board.id, author: self, color, width, pts, done: false });
    this.send({ t: 'stroke', id, board: this.board.id, color, width, pts });
    const h = new StrokeHandle(this, id, u, v);
    this.active.add(h);
    return h;
  }

  flush(h: StrokeHandle): void {
    if (h.pending.length === 0) return;
    this.send({ t: 'stroke-pts', id: h.id, pts: h.pending });
    h.pending = [];
  }

  forget(h: StrokeHandle): void {
    this.active.delete(h);
  }

  /** 接続断などで書きかけを打ち切る。 */
  abortAll(): void {
    for (const h of [...this.active]) {
      h.ended = true;
      this.board.endStroke(h.id);
    }
    this.active.clear();
  }

  update(now: number): void {
    if (now - this.lastFlush < FLUSH_INTERVAL_MS) return;
    this.lastFlush = now;
    for (const h of this.active) this.flush(h);
  }
}
