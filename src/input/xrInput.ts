// XR 中の入力: コントローラーとハンドトラッキングを同じコードで扱う。
//   トリガー (select) / グリップ (squeeze) / ピンチ: 物を掴む (近くの物 → レイが当たった物の順)
//   ペンを掴むとレイの先にペンが付き、ペン先がボードに触れている間だけ線が引ける
//   何も持たずにボードをトリガー: レイで直接描く
//   手首パネル: 左手側に表示、右手のレイで押す

import {
  BufferGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  SphereGeometry,
  Vector3,
  type Intersection,
  type Object3D,
  type Scene,
  type WebGLRenderer,
  type XRGripSpace,
  type XRHandSpace,
  type XRTargetRaySpace,
} from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { seatForward, type AnchorSpec, type SeatSpec } from '../../shared/roomConfig.ts';
import type { BoardManager } from '../board/boardManager.ts';
import type { StrokeHandle, StrokeWriter } from '../board/strokeWriter.ts';
import { Whiteboard } from '../board/whiteboard.ts';
import { PEN_TIP } from '../scene/objectMeshes.ts';
import type { ObjectManager, SyncedObject } from '../sync/objects.ts';
import type { XRPanel } from '../ui/xrPanel.ts';
import { pointWorldToShared, worldToShared } from '../util/pose.ts';

type Button = 'select' | 'squeeze';

const PEN_WIDTH = 0.004;
const RAY_INK_WIDTH = 0.005;
const RAY_LENGTH = 3;
/** ペンを持ったときの、レイ原点からペン中心までのオフセット (ペン軸 = レイ方向)。 */
const PEN_OFFSET = new Matrix4().makeTranslation(0, 0, -0.03);
/** ペン先がボード面からこの範囲にあれば接触とみなす (表側 +, 裏側 -)。 */
const CONTACT_FRONT = 0.008;
const CONTACT_BACK = -0.05;

interface Hold {
  id: string;
  button: Button;
  attach: Object3D;
  offset: Matrix4;
  pen: boolean;
  penColor: string;
  stroke: StrokeHandle | null;
}

class HandState {
  readonly index: number;
  readonly controller: XRTargetRaySpace;
  readonly grip: XRGripSpace;
  readonly hand: XRHandSpace;
  readonly ray: Line;
  readonly tipMarker: Mesh;
  source: XRInputSource | null = null;
  hold: Hold | null = null;
  rayStroke: StrokeHandle | null = null;
  rayStrokeButton: Button | null = null;

  constructor(index: number, controller: XRTargetRaySpace, grip: XRGripSpace, hand: XRHandSpace) {
    this.index = index;
    this.controller = controller;
    this.grip = grip;
    this.hand = hand;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
    this.ray = new Line(geo, new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7 }));
    this.ray.name = 'ray';
    this.ray.scale.z = RAY_LENGTH;
    controller.add(this.ray);
    this.tipMarker = new Mesh(new SphereGeometry(0.008, 12, 8), new MeshBasicMaterial({ color: '#ffd166' }));
    this.tipMarker.visible = false;
  }

  get isHand(): boolean {
    return !!this.source?.hand;
  }

  get handedness(): XRHandedness {
    return this.source?.handedness ?? 'none';
  }

  haptic(intensity: number, ms: number): void {
    const act = this.source?.gamepad?.hapticActuators?.[0] as
      | { pulse?: (v: number, d: number) => Promise<boolean> }
      | undefined;
    act?.pulse?.(intensity, ms)?.catch(() => {});
  }
}

export interface XRInputDeps {
  renderer: WebGLRenderer;
  scene: Scene;
  sharedRoot: Object3D;
  objects: ObjectManager;
  boards: BoardManager;
  strokes: StrokeWriter;
  panel: XRPanel;
  inkColor(): string;
  isCalibrating(): boolean;
  onCalibrationPoint(pWorld: Vector3): void;
  onPanelButton(id: string): void;
  onBoardClear(boardId: string): void;
}

export class XRInput {
  readonly hands: HandState[] = [];
  private readonly deps: XRInputDeps;
  private readonly raycaster = new Raycaster();
  private readonly tmpM = new Matrix4();
  private readonly tmpP = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly tmpV = new Vector3();
  /** パネルを持っている手 (null ならワールド固定)。 */
  private panelHand: HandState | null = null;
  private worldPanelSeat: { seat: SeatSpec; anchor: AnchorSpec } | null = null;

  constructor(deps: XRInputDeps) {
    this.deps = deps;
    const { renderer, scene } = deps;
    const controllerModels = new XRControllerModelFactory();
    const handModels = new XRHandModelFactory();

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const hand = renderer.xr.getHand(i);
      const h = new HandState(i, controller, grip, hand);
      this.hands.push(h);

      grip.add(controllerModels.createControllerModel(grip));
      hand.add(handModels.createHandModel(hand, 'mesh'));
      scene.add(controller, grip, hand, h.tipMarker);

      controller.addEventListener('connected', (e) => {
        h.source = (e as unknown as { data: XRInputSource }).data;
        this.reattachPanel();
      });
      controller.addEventListener('disconnected', () => {
        this.endHold(h);
        this.endRayStroke(h);
        h.source = null;
        this.reattachPanel();
      });
      controller.addEventListener('selectstart', () => this.press(h, 'select'));
      controller.addEventListener('selectend', () => this.releaseButton(h, 'select'));
      controller.addEventListener('squeezestart', () => this.press(h, 'squeeze'));
      controller.addEventListener('squeezeend', () => this.releaseButton(h, 'squeeze'));
    }
    deps.objects.onLostHold = (id) => {
      for (const h of this.hands) if (h.hold?.id === id) this.endHold(h, false);
    };
  }

  /** 左手 (ハンドトラッキングでもよい) があれば手首に、無ければ席の前に固定してパネルを出す。 */
  reattachPanel(): void {
    const panel = this.deps.panel.mesh;
    const left = this.hands.find((h) => h.source && h.handedness === 'left' && h.source.targetRayMode === 'tracked-pointer');
    if (left) {
      if (this.panelHand === left && panel.parent === left.grip) return;
      this.panelHand = left;
      left.grip.add(panel);
      panel.position.set(0, 0.07, 0.03);
      panel.rotation.set(-0.6, 0, 0);
      return;
    }
    this.panelHand = null;
    if (this.worldPanelSeat) this.placeWorldPanel(this.worldPanelSeat.seat, this.worldPanelSeat.anchor);
  }

  /** World-locked panel: in front-left of your seat, about 1 m above the floor. */
  placeWorldPanel(seat: SeatSpec, anchor: AnchorSpec): void {
    this.worldPanelSeat = { seat, anchor };
    if (this.panelHand) return;
    const panel = this.deps.panel.mesh;
    const [fx, fz] = seatForward(seat.yaw);
    const lx = fz;
    const lz = -fx; // left of the seat
    this.deps.sharedRoot.add(panel);
    panel.position.set(seat.x + fx * 0.35 + lx * 0.32, 1.0 - anchor.floorOffset, seat.z + fz * 0.35 + lz * 0.32);
    panel.rotation.set(0, seat.yaw, 0);
    panel.rotateX(-0.35);
  }

  /** 左右の手の姿勢 (ワールド行列)。アバター送信用。 */
  handMatrix(handedness: 'left' | 'right'): Matrix4 | null {
    const h = this.hands.find((x) => x.source && x.handedness === handedness && x.source.targetRayMode !== 'transient-pointer');
    if (!h) return null;
    const space = h.grip.visible ? h.grip : h.controller.visible ? h.controller : null;
    return space ? space.matrixWorld : null;
  }

  update(): void {
    const { scene, objects, panel, sharedRoot } = this.deps;
    scene.updateMatrixWorld();
    const calibrating = this.deps.isCalibrating();
    let panelHover: { x: number; y: number } | null = null;

    for (const h of this.hands) {
      if (!h.source) {
        h.tipMarker.visible = false;
        continue;
      }
      if (h.hold && !objects.isLocallyHeld(h.hold.id)) this.endHold(h, false);

      // 掴んでいる物を手に追従させる
      if (h.hold) {
        const world = this.tmpM.multiplyMatrices(h.hold.attach.matrixWorld, h.hold.offset);
        worldToShared(world, sharedRoot, this.tmpP, this.tmpQ);
        objects.moveLocal(h.hold.id, this.tmpP, this.tmpQ);
        if (h.hold.pen) this.updatePen(h, world);
      }

      // キャリブレーション中は指先/コントローラー先端に目印
      h.tipMarker.visible = calibrating;
      if (calibrating) this.tipWorld(h, h.tipMarker.position);

      // レイ: パネル・ボタン・ボード・物に当てて長さとホバーを決める
      const showRay = !h.hold && h.source.targetRayMode !== 'transient-pointer';
      h.ray.visible = showRay;
      if (!showRay && !h.rayStroke) continue;
      const hit = this.rayHit(h);
      h.ray.scale.z = hit ? hit.distance : RAY_LENGTH;
      if (hit?.object === panel.mesh && hit.uv) panelHover = hit.uv;
      if (h.rayStroke) {
        if (hit?.object.userData.boardId === h.rayStroke.boardId && hit.object.userData.boardSurface && hit.uv) {
          h.rayStroke.add(hit.uv.x, hit.uv.y);
        }
      }
      (h.ray.material as LineBasicMaterial).color.set(hit && !hit.object.userData.boardSurface ? '#7cc4ff' : '#ffffff');
    }
    panel.setHover(panelHover);
  }

  /** 全部手放す (セッション終了・再接続時)。 */
  releaseAll(): void {
    for (const h of this.hands) {
      this.endHold(h);
      this.endRayStroke(h);
    }
  }

  // ---- 内部 ----

  private press(h: HandState, button: Button): void {
    const { objects, boards, panel } = this.deps;
    this.deps.scene.updateMatrixWorld();

    if (button === 'select') {
      const hit = this.rayHit(h);
      if (hit?.object === panel.mesh && hit.uv) {
        const id = panel.buttonAt(hit.uv);
        if (id) {
          h.haptic(0.4, 30);
          this.deps.onPanelButton(id);
        }
        return;
      }
      const clearBoard = hit && hit.object.userData.action === 'board-clear' ? boards.boardOf(hit.object) : undefined;
      if (clearBoard) {
        h.haptic(0.4, 30);
        this.deps.onBoardClear(clearBoard.id);
        return;
      }
      if (this.deps.isCalibrating()) {
        h.haptic(0.8, 60);
        this.deps.onCalibrationPoint(this.tipWorld(h, new Vector3()));
        return;
      }
    }
    if (h.hold || h.rayStroke) return;

    // 1) 手の届く範囲の物
    const tipShared = pointWorldToShared(this.tipWorld(h, this.tmpV), this.deps.sharedRoot, new Vector3());
    let target: SyncedObject | null | undefined = objects.nearest(tipShared);
    // 2) レイが当たった物 / ボード
    if (!target) {
      const hit = this.rayHit(h);
      const id = hit?.object.userData.objectId as string | undefined;
      if (id) target = objects.get(id);
      else if (hit?.object.userData.boardSurface && hit.uv && button === 'select') {
        h.rayStroke = this.deps.strokes.begin(hit.object.userData.boardId as string, this.deps.inkColor(), RAY_INK_WIDTH, hit.uv.x, hit.uv.y);
        h.rayStrokeButton = button;
        return;
      }
    }
    if (target) this.grab(h, target, button);
  }

  private grab(h: HandState, obj: SyncedObject, button: Button): void {
    if (!this.deps.objects.tryGrab(obj.id)) {
      h.haptic(0.2, 120); // 他の人が持っている
      return;
    }
    // 反対の手から持ち替え
    for (const other of this.hands) if (other !== h && other.hold?.id === obj.id) this.endHold(other, false);

    const pen = obj.kind === 'pen';
    const attach: Object3D = pen || h.isHand || !h.grip.visible ? h.controller : h.grip;
    const offset = pen
      ? PEN_OFFSET.clone()
      : new Matrix4().copy(attach.matrixWorld).invert().multiply(obj.root.matrixWorld);
    h.hold = { id: obj.id, button, attach, offset, pen, penColor: obj.color, stroke: null };
    h.haptic(0.5, 40);
  }

  private releaseButton(h: HandState, button: Button): void {
    if (h.rayStroke && h.rayStrokeButton === button) this.endRayStroke(h);
    if (h.hold && h.hold.button === button) this.endHold(h);
  }

  private endHold(h: HandState, sendRelease = true): void {
    if (!h.hold) return;
    h.hold.stroke?.end();
    if (sendRelease) this.deps.objects.release(h.hold.id);
    h.hold = null;
  }

  private endRayStroke(h: HandState): void {
    h.rayStroke?.end();
    h.rayStroke = null;
    h.rayStrokeButton = null;
  }

  private updatePen(h: HandState, penWorld: Matrix4): void {
    const hold = h.hold!;
    const tip = this.tmpV.copy(PEN_TIP).applyMatrix4(penWorld);
    // The board whose surface the tip touches (closest one if several).
    let touched: { id: string; u: number; v: number; d: number } | null = null;
    for (const board of this.deps.boards.all()) {
      const b = board.toBoard(tip);
      if (!Whiteboard.inBounds(b) || b.depth >= CONTACT_FRONT || b.depth <= CONTACT_BACK) continue;
      if (!touched || Math.abs(b.depth) < touched.d) touched = { id: board.id, u: b.u, v: b.v, d: Math.abs(b.depth) };
    }
    if (hold.stroke && (!touched || touched.id !== hold.stroke.boardId)) {
      hold.stroke.end();
      hold.stroke = null;
    }
    if (!touched) return;
    if (!hold.stroke) {
      hold.stroke = this.deps.strokes.begin(touched.id, hold.penColor, PEN_WIDTH, touched.u, touched.v);
      h.haptic(0.3, 20);
    } else hold.stroke.add(touched.u, touched.v);
  }

  /** 指先 (ハンド) またはコントローラー先端のワールド座標。 */
  private tipWorld(h: HandState, out: Vector3): Vector3 {
    if (h.isHand) {
      const tip = h.hand.joints['index-finger-tip'];
      if (tip && tip.visible) return tip.getWorldPosition(out);
    }
    return h.controller.getWorldPosition(out);
  }

  private rayHit(h: HandState): Intersection | null {
    const { panel, boards, objects } = this.deps;
    this.raycaster.setFromXRController(h.controller);
    this.raycaster.far = RAY_LENGTH;
    const targets: Object3D[] = [...boards.surfaces(), ...boards.clearButtons(), ...objects.pickables()];
    if (panel.mesh.parent && this.panelHand !== h) targets.unshift(panel.mesh);
    const hits = this.raycaster.intersectObjects(targets, true);
    // パネルは depthTest なしで最前面に描くので、当たっていれば最優先
    return hits.find((x) => x.object === panel.mesh) ?? hits[0] ?? null;
  }
}

