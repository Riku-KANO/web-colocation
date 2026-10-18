// デスクトップ / スマホ (非 XR) の入力。ヘッドセットが無くても同じルームに参加できる。
//   ドラッグ (物の上): 水平移動 / Shift+ドラッグ: 上下移動 / ドラッグ中のホイール or Q・E: 回転
//   ドラッグ (ボード上): 描く / それ以外: 視点の回転・ズーム

import { Plane, Quaternion, Raycaster, Vector2, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { seatForward, type AnchorSpec, type SeatSpec } from '../../shared/roomConfig.ts';
import type { BoardManager } from '../board/boardManager.ts';
import type { StrokeHandle, StrokeWriter } from '../board/strokeWriter.ts';
import type { ObjectManager } from '../sync/objects.ts';
import { pointWorldToShared } from '../util/pose.ts';

const INK_WIDTH = 0.005;
const UP = new Vector3(0, 1, 0);
const ROTATE_STEP = Math.PI / 12;

export interface DesktopInputDeps {
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  sharedRoot: Object3D;
  objects: ObjectManager;
  boards: BoardManager;
  strokes: StrokeWriter;
  inkColor(): string;
  onBoardClear(boardId: string): void;
}

interface Drag {
  id: string;
  pointerId: number;
  plane: Plane;
  offset: Vector3;
}

export class DesktopInput {
  readonly controls: OrbitControls;
  enabled = true;
  /** 共有座標系でのカーソル位置 (他の参加者には「手」として見える)。 */
  readonly cursor = new Vector3();
  cursorActive = false;

  private readonly deps: DesktopInputDeps;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private drag: Drag | null = null;
  private stroke: { handle: StrokeHandle; pointerId: number } | null = null;
  private readonly tmp = new Vector3();
  private readonly tmpQ = new Quaternion();

  constructor(deps: DesktopInputDeps) {
    this.deps = deps;
    const c = deps.canvas;
    // OrbitControls より先に受け取るため capture で登録する
    c.addEventListener('pointerdown', this.onDown, { capture: true });
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    window.addEventListener('keydown', this.onKey);
    this.controls = new OrbitControls(deps.camera, c);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 6;
    this.controls.minDistance = 0.3;
  }

  /** 自分の席からテーブルを見下ろす視点にする。 */
  /** Look from slightly behind and above the seat, in the direction the seat faces. */
  placeCamera(seat: SeatSpec, anchor: AnchorSpec): void {
    const { sharedRoot, camera } = this.deps;
    sharedRoot.updateMatrixWorld(true);
    const [fx, fz] = seatForward(seat.yaw);
    const eye = sharedRoot.localToWorld(new Vector3(seat.x - fx * 0.55, 1.45 - anchor.floorOffset, seat.z - fz * 0.55));
    const target = sharedRoot.localToWorld(new Vector3(seat.x + fx * 1.3, 0.85 - anchor.floorOffset, seat.z + fz * 1.3));
    camera.position.copy(eye);
    this.controls.target.copy(target);
    camera.lookAt(target);
    this.controls.update();
  }

  update(): void {
    if (this.enabled) this.controls.update();
  }

  /** 接続断などで操作を打ち切る。 */
  cancel(): void {
    if (this.drag) this.deps.objects.release(this.drag.id);
    this.drag = null;
    this.stroke?.handle.end();
    this.stroke = null;
    this.cursorActive = false;
    this.controls.enabled = true;
  }

  private pick(e: PointerEvent, targets: Object3D[]) {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.deps.camera);
    return this.raycaster.intersectObjects(targets, true)[0] ?? null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0 || this.drag || this.stroke) return;
    const { objects, boards } = this.deps;
    this.deps.sharedRoot.updateMatrixWorld(true);
    const hit = this.pick(e, [...boards.clearButtons(), ...boards.surfaces(), ...objects.pickables()]);
    if (!hit) return;

    const board = boards.boardOf(hit.object);
    if (board && hit.object === board.clearButton) {
      this.deps.onBoardClear(board.id);
      this.suppressOrbit(e);
      return;
    }
    if (board && hit.object === board.surface && hit.uv) {
      const handle = this.deps.strokes.begin(board.id, this.deps.inkColor(), INK_WIDTH, hit.uv.x, hit.uv.y);
      if (!handle) return;
      this.stroke = { handle, pointerId: e.pointerId };
      this.setCursor(hit.point);
      this.suppressOrbit(e);
      return;
    }
    const id = hit.object.userData.objectId as string | undefined;
    if (!id || !objects.tryGrab(id)) return;
    const obj = objects.get(id)!;
    const objWorld = obj.root.getWorldPosition(new Vector3());
    const normal = e.shiftKey
      ? this.deps.camera.getWorldDirection(new Vector3()).setY(0).normalize().negate()
      : UP.clone();
    if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
    this.drag = { id, pointerId: e.pointerId, plane, offset: objWorld.sub(hit.point) };
    this.setCursor(hit.point);
    this.suppressOrbit(e);
  };

  private onMove = (e: PointerEvent) => {
    const { objects, boards, sharedRoot } = this.deps;
    if (this.drag && e.pointerId === this.drag.pointerId) {
      const o = objects.get(this.drag.id);
      if (!o || !objects.isLocallyHeld(this.drag.id)) {
        this.endDrag(false);
        return;
      }
      this.pick(e, []);
      const p = this.raycaster.ray.intersectPlane(this.drag.plane, this.tmp);
      if (!p) return;
      this.setCursor(p);
      p.add(this.drag.offset);
      const shared = pointWorldToShared(p, sharedRoot, new Vector3());
      shared.y = Math.max(shared.y, -0.7); // 床より下には行かせない
      objects.moveLocal(this.drag.id, shared, o.root.quaternion);
      return;
    }
    if (this.stroke && e.pointerId === this.stroke.pointerId) {
      const surface = boards.get(this.stroke.handle.boardId)?.surface;
      const hit = surface ? this.pick(e, [surface]) : null;
      if (hit?.uv) {
        this.stroke.handle.add(hit.uv.x, hit.uv.y);
        this.setCursor(hit.point);
      }
      return;
    }
    if (this.enabled && e.pointerType === 'mouse') {
      const hit = this.pick(e, [...boards.clearButtons(), ...boards.surfaces(), ...objects.pickables()]);
      this.deps.canvas.style.cursor = !hit
        ? ''
        : hit.object.userData.boardSurface
          ? 'crosshair'
          : hit.object.userData.action === 'board-clear'
            ? 'pointer'
            : 'grab';
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.endDrag(true);
    if (this.stroke && e.pointerId === this.stroke.pointerId) {
      this.stroke.handle.end();
      this.stroke = null;
      this.cursorActive = false;
    }
    this.controls.enabled = true;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.rotateHeld(Math.sign(e.deltaY) * ROTATE_STEP * 0.5);
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.drag) return;
    if (e.key === 'q' || e.key === 'Q') this.rotateHeld(ROTATE_STEP);
    if (e.key === 'e' || e.key === 'E') this.rotateHeld(-ROTATE_STEP);
  };

  private rotateHeld(angle: number): void {
    if (!this.drag) return;
    const o = this.deps.objects.get(this.drag.id);
    if (!o) return;
    this.tmpQ.setFromAxisAngle(UP, angle).multiply(o.root.quaternion);
    this.deps.objects.moveLocal(this.drag.id, o.root.position, this.tmpQ);
  }

  private endDrag(sendRelease: boolean): void {
    if (!this.drag) return;
    if (sendRelease) this.deps.objects.release(this.drag.id);
    this.drag = null;
    this.cursorActive = false;
    this.controls.enabled = true;
  }

  private suppressOrbit(e: PointerEvent): void {
    this.controls.enabled = false;
    this.deps.canvas.setPointerCapture(e.pointerId);
    e.stopImmediatePropagation();
  }

  private setCursor(world: Vector3): void {
    pointWorldToShared(world, this.deps.sharedRoot, this.cursor);
    this.cursorActive = true;
  }
}
