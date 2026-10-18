// 共有ホワイトボード。ストロークはボード上の正規化座標 (u, v) で同期し、
// 各端末が CanvasTexture に描き込む。ボードの大きさや置き場所が端末ごとに違っても破綻しない。

import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { BOARD, type Stroke } from '../../shared/protocol.ts';

const CANVAS_W = 1536;
const CANVAS_H = 1024;
/** テクスチャ転送の最小間隔。毎フレーム 6MB 転送するとモバイル GPU では重い。 */
const UPLOAD_INTERVAL_MS = 33;

export interface BoardHit {
  u: number;
  v: number;
  /** ボード面からの距離 (表側が正, メートル)。 */
  depth: number;
}

export class Whiteboard {
  readonly id = BOARD.id;
  readonly root = new Group();
  readonly surface: Mesh;
  readonly clearButton: Mesh;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly strokes = new Map<string, Stroke>();
  private dirty = false;
  private lastUpload = 0;
  private readonly tmp = new Vector3();

  constructor() {
    this.root.name = 'whiteboard';
    this.root.position.fromArray(BOARD.center);
    this.root.rotation.y = BOARD.yaw;

    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.surface = new Mesh(new PlaneGeometry(BOARD.width, BOARD.height), new MeshBasicMaterial({ map: this.texture }));
    this.surface.name = 'board-surface';
    this.surface.userData.boardId = this.id;

    // 枠
    const frameMat = new MeshStandardMaterial({ color: '#5b6270', roughness: 0.5 });
    const t = 0.02;
    const top = new Mesh(new BoxGeometry(BOARD.width + 2 * t, t, 0.02), frameMat);
    top.position.set(0, BOARD.height / 2 + t / 2, -0.008);
    const bottom = top.clone();
    bottom.position.y = -top.position.y;
    const left = new Mesh(new BoxGeometry(t, BOARD.height, 0.02), frameMat);
    left.position.set(-BOARD.width / 2 - t / 2, 0, -0.008);
    const right = left.clone();
    right.position.x = -left.position.x;

    this.clearButton = makeButton('ボードを消去');
    this.clearButton.position.set(BOARD.width / 2 - 0.1, -BOARD.height / 2 - 0.06, 0);
    this.clearButton.userData.action = 'board-clear';

    this.root.add(this.surface, top, bottom, left, right, this.clearButton);
    this.redrawAll();
  }

  /** ワールド座標の点をボード座標へ。 */
  toBoard(world: Vector3): BoardHit {
    this.surface.updateWorldMatrix(true, false);
    const p = this.surface.worldToLocal(this.tmp.copy(world));
    return { u: p.x / BOARD.width + 0.5, v: p.y / BOARD.height + 0.5, depth: p.z };
  }

  static inBounds(h: { u: number; v: number }): boolean {
    return h.u >= 0 && h.u <= 1 && h.v >= 0 && h.v <= 1;
  }

  load(strokes: Stroke[]): void {
    this.strokes.clear();
    for (const s of strokes) if (s.board === this.id) this.strokes.set(s.id, { ...s, pts: [...s.pts] });
    this.redrawAll();
  }

  addStroke(s: Stroke): void {
    if (s.board !== this.id || this.strokes.has(s.id)) return;
    const copy = { ...s, pts: [...s.pts] };
    this.strokes.set(s.id, copy);
    this.drawFrom(copy, 0);
  }

  appendPoints(id: string, pts: number[]): void {
    const s = this.strokes.get(id);
    if (!s || pts.length === 0) return;
    const from = Math.max(0, s.pts.length / 2 - 1);
    s.pts.push(...pts);
    this.drawFrom(s, from);
  }

  endStroke(id: string): void {
    const s = this.strokes.get(id);
    if (s) s.done = true;
  }

  clear(): void {
    this.strokes.clear();
    this.redrawAll();
  }

  get strokeCount(): number {
    return this.strokes.size;
  }

  update(now: number): void {
    if (this.dirty && now - this.lastUpload >= UPLOAD_INTERVAL_MS) {
      this.texture.needsUpdate = true;
      this.dirty = false;
      this.lastUpload = now;
    }
  }

  private redrawAll(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#fbfbf8';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    for (const s of this.strokes.values()) this.drawFrom(s, 0);
    this.dirty = true;
  }

  /** ストロークの fromPoint 番目の点以降を描く (追記分だけの差分描画)。 */
  private drawFrom(s: Stroke, fromPoint: number): void {
    const ctx = this.ctx;
    const n = s.pts.length / 2;
    if (n === 0) return;
    const px = (i: number) => s.pts[i * 2] * CANVAS_W;
    const py = (i: number) => (1 - s.pts[i * 2 + 1]) * CANVAS_H;
    const lw = Math.max(1, (s.width / BOARD.width) * CANVAS_W);
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(px(0), py(0), lw / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(px(fromPoint), py(fromPoint));
      for (let i = fromPoint + 1; i < n; i++) ctx.lineTo(px(i), py(i));
      ctx.stroke();
    }
    this.dirty = true;
  }
}

/** テキスト付きの 3D ボタン (XR 内でもレイで押せる)。 */
export function makeButton(text: string, w = 0.2, h = 0.06): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#2d3748';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height * 0.3);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(canvas.height * 0.45)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width * 0.9);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true }));
  mesh.name = `button:${text}`;
  return mesh;
}
