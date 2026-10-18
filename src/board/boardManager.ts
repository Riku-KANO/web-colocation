// All whiteboards of the current room. Strokes are routed to the board they belong to.

import { Group, type Object3D } from 'three';
import type { Stroke } from '../../shared/protocol.ts';
import type { BoardSpec } from '../../shared/roomConfig.ts';
import { Whiteboard } from './whiteboard.ts';

export class BoardManager {
  readonly root = new Group();
  private boards = new Map<string, Whiteboard>();
  private clearLabel: string;

  constructor(clearLabel = 'Clear board') {
    this.root.name = 'boards';
    this.clearLabel = clearLabel;
  }

  /** Replace all boards (room configuration changed). Existing strokes are dropped. */
  build(specs: BoardSpec[]): void {
    for (const b of this.boards.values()) {
      this.root.remove(b.root);
      b.dispose();
    }
    this.boards = new Map(specs.map((s) => [s.id, new Whiteboard(s, this.clearLabel)]));
    for (const b of this.boards.values()) this.root.add(b.root);
  }

  setClearLabel(label: string): void {
    this.clearLabel = label;
  }

  get(id: string): Whiteboard | undefined {
    return this.boards.get(id);
  }

  all(): IterableIterator<Whiteboard> {
    return this.boards.values();
  }

  /** Raycast targets: drawing surfaces. */
  surfaces(): Object3D[] {
    return [...this.boards.values()].map((b) => b.surface);
  }

  clearButtons(): Object3D[] {
    return [...this.boards.values()].map((b) => b.clearButton);
  }

  /** The board a raycast hit belongs to (surface or clear button), if any. */
  boardOf(object: Object3D): Whiteboard | undefined {
    const id = object.userData.boardId as string | undefined;
    return id ? this.boards.get(id) : undefined;
  }

  load(strokes: Stroke[]): void {
    for (const b of this.boards.values()) b.load(strokes);
  }

  addStroke(s: Stroke): void {
    this.boards.get(s.board)?.addStroke(s);
  }

  /** Points of a stroke we only know by id. */
  appendPoints(id: string, pts: number[]): void {
    for (const b of this.boards.values()) b.appendPoints(id, pts);
  }

  endStroke(id: string): void {
    for (const b of this.boards.values()) b.endStroke(id);
  }

  clear(boardId: string): void {
    this.boards.get(boardId)?.clear();
  }

  get strokeCount(): number {
    let n = 0;
    for (const b of this.boards.values()) n += b.strokeCount;
    return n;
  }

  update(now: number): void {
    for (const b of this.boards.values()) b.update(now);
  }
}
