// Shared object synchronization.
//
// Conflicts are resolved with ownership (a lock):
//   1. On grab we optimistically start moving the object locally and send `grab`.
//   2. The server confirms the first claimant and broadcasts `owner`.
//   3. A losing claimant receives `owner` / `grab-denied`, lets go and returns to the server pose.
//   4. Only the owner sends `move` (the server drops moves from anyone else).
// Non-owners follow received poses with frame-rate independent exponential smoothing.

import { Color, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Object3D } from 'three';
import type { ObjectState, Pose } from '../../shared/protocol.ts';
import type { ObjectKind } from '../../shared/roomConfig.ts';
import type { StateMsgInput } from '../net/netClient.ts';
import { modelRadius, type ModelLoader } from '../scene/modelLoader.ts';
import { buildObjectMesh, objectSignature, type BuiltObject } from '../scene/objectMeshes.ts';
import { readPose, smoothing, toPose } from '../util/pose.ts';

const SEND_INTERVAL_MS = 33; // send rate while holding (~30 Hz)
const FOLLOW_RATE = 18;
const SNAP_DISTANCE = 2;

export class SyncedObject {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly color: string;
  /** Identifies the visual (kind, colour, scale, model); a change requires rebuilding. */
  readonly signature: string;
  readonly built: BuiltObject;
  owner: string | null = null;
  /** Held on this device (including optimistic holds). */
  localHold = false;

  readonly targetP = new Vector3();
  readonly targetQ = new Quaternion();
  dirty = false;
  lastSent = 0;

  constructor(state: ObjectState) {
    this.id = state.id;
    this.kind = state.kind;
    this.color = state.color;
    this.signature = objectSignature(state);
    this.built = buildObjectMesh(state);
    this.root.name = `obj:${state.id}`;
    this.root.traverse((o) => (o.userData.objectId = state.id));
    readPose(state.pose, this.targetP, this.targetQ);
    this.root.position.copy(this.targetP);
    this.root.quaternion.copy(this.targetQ);
    this.owner = state.owner;
  }

  get root(): Object3D {
    return this.built.root;
  }

  setTarget(pose: Pose, snap = false): void {
    readPose(pose, this.targetP, this.targetQ);
    if (snap || this.root.position.distanceTo(this.targetP) > SNAP_DISTANCE) {
      this.root.position.copy(this.targetP);
      this.root.quaternion.copy(this.targetQ);
    }
  }
}

export interface ObjectManagerDeps {
  send(msg: StateMsgInput): void;
  selfId(): string | null;
  isPeerPresent(id: string): boolean;
  peerColor(id: string): string | null;
  /** Loads glTF models for `kind: model` objects. */
  models?: ModelLoader;
}

export class ObjectManager {
  readonly root = new Group();
  /** Called when we lose an object we were holding (to a conflict or a reconnect). */
  onLostHold: (id: string) => void = () => {};

  private readonly objs = new Map<string, SyncedObject>();
  private readonly deps: ObjectManagerDeps;
  private readonly tmpColor = new Color();

  constructor(deps: ObjectManagerDeps) {
    this.deps = deps;
    this.root.name = 'objects';
  }

  get(id: string): SyncedObject | undefined {
    return this.objs.get(id);
  }

  all(): IterableIterator<SyncedObject> {
    return this.objs.values();
  }

  /** Replace everything with a snapshot (welcome / objects). */
  load(states: ObjectState[]): void {
    const seen = new Set<string>();
    for (const s of states) {
      seen.add(s.id);
      let o = this.objs.get(s.id);
      if (o && o.signature !== objectSignature(s)) {
        // Same id but a different object (room reconfigured): rebuild it.
        this.dropLocal(o);
        this.root.remove(o.root);
        o.built.dispose();
        this.objs.delete(s.id);
        o = undefined;
      }
      if (!o) {
        o = new SyncedObject(s);
        this.objs.set(s.id, o);
        this.root.add(o.root);
        if (s.kind === 'model' && s.model) this.loadModel(o, s.model);
      }
      const self = this.deps.selfId();
      // Leave objects we are holding alone (reset-objects keeps them where they are).
      if (o.localHold && s.owner === self && self !== null) continue;
      this.dropLocal(o);
      o.owner = s.owner;
      o.setTarget(s.pose, true);
    }
    for (const [id, o] of this.objs) {
      if (!seen.has(id)) {
        this.dropLocal(o);
        this.root.remove(o.root);
        o.built.dispose();
        this.objs.delete(id);
      }
    }
    this.refreshHighlights();
  }

  onOwner(id: string, owner: string | null, pose?: Pose): void {
    const o = this.objs.get(id);
    if (!o) return;
    o.owner = owner;
    if (owner !== this.deps.selfId()) {
      if (o.localHold) this.dropLocal(o); // someone else grabbed it first
      if (pose) o.setTarget(pose);
    }
    this.refreshHighlights();
  }

  onMove(id: string, pose: Pose): void {
    const o = this.objs.get(id);
    if (!o || o.localHold) return;
    o.setTarget(pose);
  }

  onGrabDenied(id: string, owner: string | null, pose: Pose): void {
    const o = this.objs.get(id);
    if (!o) return;
    o.owner = owner;
    this.dropLocal(o);
    o.setTarget(pose);
    this.refreshHighlights();
  }

  /** True if grabbed (optimistically). Objects held by others cannot be grabbed. */
  tryGrab(id: string): boolean {
    const o = this.objs.get(id);
    const self = this.deps.selfId();
    if (!o || !self) return false;
    if (o.owner && o.owner !== self && this.deps.isPeerPresent(o.owner)) return false;
    if (!o.localHold) {
      o.localHold = true;
      o.owner = self;
      this.deps.send({ t: 'grab', id });
      this.refreshHighlights();
    }
    return true;
  }

  /** Update a held object's pose (shared frame). Sending is batched in update(). */
  moveLocal(id: string, p: Vector3, q: Quaternion): void {
    const o = this.objs.get(id);
    if (!o || !o.localHold) return;
    o.root.position.copy(p);
    o.root.quaternion.copy(q);
    o.targetP.copy(p);
    o.targetQ.copy(q);
    o.dirty = true;
  }

  release(id: string): void {
    const o = this.objs.get(id);
    if (!o || !o.localHold) return;
    o.localHold = false;
    o.dirty = false;
    o.owner = null;
    this.deps.send({ t: 'release', id, pose: toPose(o.root.position, o.root.quaternion) });
    this.refreshHighlights();
  }

  isLocallyHeld(id: string): boolean {
    return this.objs.get(id)?.localHold ?? false;
  }

  /** On disconnect, treat every held object as released. */
  dropAllLocal(): void {
    for (const o of this.objs.values()) this.dropLocal(o);
    this.refreshHighlights();
  }

  /** Raycast targets (excluding objects held by others). */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const o of this.objs.values()) if (this.grabbableBy(o)) out.push(o.root);
    return out;
  }

  /** The grabbable object nearest to a point in the shared frame. */
  nearest(pShared: Vector3): SyncedObject | null {
    let best: SyncedObject | null = null;
    let bestD = Infinity;
    for (const o of this.objs.values()) {
      if (!this.grabbableBy(o)) continue;
      const d = o.root.position.distanceTo(pShared);
      if (d < o.built.grabRadius && d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  update(dt: number, now: number): void {
    const k = smoothing(FOLLOW_RATE, dt);
    for (const o of this.objs.values()) {
      if (o.localHold) {
        if (o.dirty && now - o.lastSent >= SEND_INTERVAL_MS) {
          o.dirty = false;
          o.lastSent = now;
          this.deps.send({ t: 'move', id: o.id, pose: toPose(o.root.position, o.root.quaternion) });
        }
      } else {
        o.root.position.lerp(o.targetP, k);
        o.root.quaternion.slerp(o.targetQ, k);
      }
    }
  }

  private grabbableBy(o: SyncedObject): boolean {
    const self = this.deps.selfId();
    return !(o.owner && o.owner !== self && this.deps.isPeerPresent(o.owner));
  }

  private dropLocal(o: SyncedObject): void {
    if (!o.localHold) return;
    o.localHold = false;
    o.dirty = false;
    this.onLostHold(o.id);
  }

  /** Replace a model placeholder with the loaded glTF (if the object still exists). */
  private loadModel(o: SyncedObject, model: NonNullable<ObjectState['model']>): void {
    const loader = this.deps.models;
    if (!loader) return;
    loader
      .load(model.src)
      .then((scene) => {
        if (this.objs.get(o.id) !== o) return; // rebuilt or removed meanwhile
        scene.scale.multiplyScalar(model.scale);
        const placeholder = [...o.built.root.children];
        for (const c of placeholder) {
          o.built.root.remove(c);
          (c as Mesh).geometry?.dispose();
        }
        o.built.root.add(scene);
        o.built.root.traverse((x) => (x.userData.objectId = o.id));
        o.built.materials.length = 0;
        scene.traverse((x) => {
          const mesh = x as Mesh;
          if (!mesh.isMesh) return;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (m instanceof MeshStandardMaterial) o.built.materials.push(m);
          }
        });
        o.built.grabRadius = model.grabRadius ?? modelRadius(scene);
        this.refreshHighlights();
      })
      .catch((e: unknown) => {
        console.warn(`[colo] model ${model.src} not loaded:`, e);
        for (const m of o.built.materials) m.color.set('#d64545'); // keep a visible placeholder
      });
  }

  /** Show who is holding an object with an emissive glow in their colour. */
  refreshHighlights(): void {
    const self = this.deps.selfId();
    for (const o of this.objs.values()) {
      let intensity = 0;
      if (o.owner && o.owner === self) {
        this.tmpColor.set('#ffffff');
        intensity = 0.25;
      } else if (o.owner && this.deps.isPeerPresent(o.owner)) {
        this.tmpColor.set(this.deps.peerColor(o.owner) ?? '#ffffff');
        intensity = 0.6;
      }
      for (const m of o.built.materials) {
        m.emissive.copy(this.tmpColor);
        m.emissiveIntensity = intensity;
      }
    }
  }
}
