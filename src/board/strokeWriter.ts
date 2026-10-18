// Strokes the local user is drawing: drawn locally right away, thinned out and sent in batches.

import type { StateMsgInput } from '../net/netClient.ts';
import type { BoardManager } from './boardManager.ts';

const FLUSH_INTERVAL_MS = 40;
/** Skip moves shorter than this (normalized coordinates; ~2 mm on a 1.2 m board). */
const MIN_STEP = 0.0016;

const q = (x: number) => Math.round(x * 1e4) / 1e4;

export class StrokeHandle {
  readonly id: string;
  readonly boardId: string;
  private lastU: number;
  private lastV: number;
  pending: number[] = [];
  ended = false;
  private readonly writer: StrokeWriter;

  constructor(writer: StrokeWriter, id: string, boardId: string, u: number, v: number) {
    this.writer = writer;
    this.id = id;
    this.boardId = boardId;
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
    this.writer.boards.get(this.boardId)?.appendPoints(this.id, pts);
  }

  end(): void {
    if (this.ended) return;
    this.writer.flush(this);
    this.ended = true;
    this.writer.boards.get(this.boardId)?.endStroke(this.id);
    this.writer.send({ t: 'stroke-end', id: this.id });
    this.writer.forget(this);
  }
}

export class StrokeWriter {
  readonly boards: BoardManager;
  readonly send: (msg: StateMsgInput) => void;
  private readonly selfId: () => string | null;
  private readonly active = new Set<StrokeHandle>();
  private counter = 0;
  private lastFlush = 0;

  constructor(boards: BoardManager, send: (msg: StateMsgInput) => void, selfId: () => string | null) {
    this.boards = boards;
    this.send = send;
    this.selfId = selfId;
  }

  begin(boardId: string, color: string, width: number, u: number, v: number): StrokeHandle | null {
    const self = this.selfId();
    const board = this.boards.get(boardId);
    if (!self || !board) return null;
    const id = `${self}-${++this.counter}`;
    const pts = [q(u), q(v)];
    board.addStroke({ id, board: boardId, author: self, color, width, pts, done: false });
    this.send({ t: 'stroke', id, board: boardId, color, width, pts });
    const h = new StrokeHandle(this, id, boardId, u, v);
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

  /** Abort strokes in progress (disconnect / room reconfigured). */
  abortAll(): void {
    for (const h of [...this.active]) {
      h.ended = true;
      this.boards.get(h.boardId)?.endStroke(h.id);
    }
    this.active.clear();
  }

  update(now: number): void {
    if (now - this.lastFlush < FLUSH_INTERVAL_MS) return;
    this.lastFlush = now;
    for (const h of this.active) this.flush(h);
  }
}
