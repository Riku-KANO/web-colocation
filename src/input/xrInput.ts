// Input in XR: controllers and hand tracking share the same code.
//   Trigger (select) / grip (squeeze) / pinch: grab an object (nearby objects first, then the ray hit)
//   A grabbed pen sits at the end of the ray and only draws while its tip touches a board
//   Trigger on a board with nothing held: draw directly with the ray
//   Wrist panel: shown on the left hand, pressed with the right hand's ray

import {
  BoxGeometry,
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
/** Offset from the ray origin to the pen's centre while held (pen axis = ray direction). */
const PEN_OFFSET = new Matrix4().makeTranslation(0, 0, -0.03);
/** The pen tip counts as touching when within this distance of the board surface (front +, back -). */
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
  readonly fallbackModel = new Mesh(new BoxGeometry(0.035, 0.035, 0.11), new MeshBasicMaterial({ color: '#3a3f4a' }));
  controllerModel: Object3D | null = null;
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
  /** Base URL of WebXR input profiles; null = jsDelivr; "none" = built-in shapes only. */
  inputProfilesPath?: string | null;
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
  /** Hand carrying the panel (null = fixed in the world). */
  private panelHand: HandState | null = null;
  private worldPanelSeat: { seat: SeatSpec; anchor: AnchorSpec } | null = null;

  constructor(deps: XRInputDeps) {
    this.deps = deps;
    const { renderer, scene } = deps;
    // Controller / hand models come from the WebXR input profiles (jsDelivr by default). Closed
    // networks can self-host them (inputProfilesPath) or use "none" for built-in shapes only.
    const path = deps.inputProfilesPath?.replace(/\/$/, '') ?? null;
    const offline = path === 'none';
    const controllerModels = offline ? null : new XRControllerModelFactory();
    const handModels = new XRHandModelFactory();
    if (path && !offline) {
      controllerModels!.setPath(path);
      handModels.setPath(`${path}/generic-hand/`);
    }

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      const hand = renderer.xr.getHand(i);
      const h = new HandState(i, controller, grip, hand);
      this.hands.push(h);

      // Simple stand-in shown until (or instead of) the real controller model.
      h.fallbackModel.position.set(0, -0.01, 0.03);
      grip.add(h.fallbackModel);
      if (controllerModels) {
        h.controllerModel = controllerModels.createControllerModel(grip);
        grip.add(h.controllerModel);
      }
      hand.add(handModels.createHandModel(hand, offline ? 'spheres' : 'mesh'));
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

  /** Show the panel on the left wrist (hand tracking works too), or fixed in front of the seat without a left hand. */
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

  /** Poses of both hands (world matrices), sent as part of our avatar. */
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
      h.fallbackModel.visible = !h.isHand && !(h.controllerModel && h.controllerModel.children.length > 0);
      if (h.hold && !objects.isLocallyHeld(h.hold.id)) this.endHold(h, false);

      // Held objects follow the hand.
      if (h.hold) {
        const world = this.tmpM.multiplyMatrices(h.hold.attach.matrixWorld, h.hold.offset);
        worldToShared(world, sharedRoot, this.tmpP, this.tmpQ);
        objects.moveLocal(h.hold.id, this.tmpP, this.tmpQ);
        if (h.hold.pen) this.updatePen(h, world);
      }

      // During calibration, mark the fingertip / controller tip.
      h.tipMarker.visible = calibrating;
      if (calibrating) this.tipWorld(h, h.tipMarker.position);

      // Ray: hit-test the panel, buttons, boards and objects to set its length and hover state.
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

  /** Release everything (on session end or reconnect). */
  releaseAll(): void {
    for (const h of this.hands) {
      this.endHold(h);
      this.endRayStroke(h);
    }
  }

  // ---- internals ----

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

    // 1) Objects within reach
    const tipShared = pointWorldToShared(this.tipWorld(h, this.tmpV), this.deps.sharedRoot, new Vector3());
    let target: SyncedObject | null | undefined = objects.nearest(tipShared);
    // 2) Object or board hit by the ray
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
      h.haptic(0.2, 120); // someone else is holding it
      return;
    }
    // Hand over from the other hand.
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

  /** World position of the fingertip (hand) or controller tip. */
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
    // The panel is drawn on top without depthTest, so a panel hit always wins.
    return hits.find((x) => x.object === panel.mesh) ?? hits[0] ?? null;
  }
}

