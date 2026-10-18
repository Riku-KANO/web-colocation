// Shared frame management.
//
// Every device's WebXR reference space (local-floor) has its own origin and heading. Each device
// therefore computes a rigid transform M = local <- shared and puts all shared content under
// `sharedRoot` (matrix = M). Only shared-frame values ever go over the network.
//
//   - Remote (different rooms): place the room once (1 point, or automatically at your seat);
//     the rotation is chosen from your assigned seat.
//   - Colocated (same physical room): everyone touches the same two physical points in the same
//     order, so the shared frame matches the physical room.
//
// WebXR has no standard shared/cloud anchors, so this manual calibration is the lowest common
// denominator that works in every browser. Afterwards an XRAnchor (where supported) keeps the
// frame aligned when tracking relocalizes.

import { Group, Matrix4, Quaternion, Vector3 } from 'three';
import { seatForward, type AnchorSpec, type SeatSpec } from '../../shared/roomConfig.ts';

const UP = new Vector3(0, 1, 0);

/** Horizontal angle of a vector measured from +Z towards +X; R_y(θ) adds θ to it. */
function heading(x: number, z: number): number {
  return Math.atan2(x, z);
}

function compose(origin: Vector3, yaw: number): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(UP, yaw);
  return new Matrix4().compose(origin, q, new Vector3(1, 1, 1));
}

/** Direction from the room origin towards a seat (falls back to "behind" the seat's facing). */
function seatDirection(seat: SeatSpec): [number, number] {
  if (Math.hypot(seat.x, seat.z) > 1e-3) return [seat.x, seat.z];
  const [fx, fz] = seatForward(seat.yaw);
  return [-fx, -fz];
}

/**
 * One-point placement (remote). `point` becomes the room origin (the centre of your real table for
 * table anchors; projected to the floor for floor anchors). The rotation makes the horizontal
 * direction point → your head match the direction origin → your seat in the shared frame.
 */
export function frameFromOnePoint(point: Vector3, viewer: Vector3, seat: SeatSpec, anchor: AnchorSpec): Matrix4 {
  const origin = point.clone();
  if (anchor.kind === 'floor') origin.y = 0;
  const [sx, sz] = seatDirection(seat);
  let dx = viewer.x - point.x;
  let dz = viewer.z - point.z;
  if (Math.hypot(dx, dz) < 1e-3) {
    dx = sx;
    dz = sz;
  }
  return compose(origin, heading(dx, dz) - heading(sx, sz));
}

/**
 * Two-point calibration (colocated). Origin = midpoint, shared +X = horizontal direction A → B,
 * height = average of both points. Touching the middle of the two short edges of a table puts the
 * origin at the table centre.
 */
export function frameFromTwoPoints(a: Vector3, b: Vector3): Matrix4 {
  const origin = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // Align R_y(θ)·(1,0,0) = (cosθ, 0, -sinθ) with (dx, dz).
  return compose(origin, Math.atan2(-dz, dx));
}

/**
 * Initial placement when entering XR: put the viewer at their seat, looking the way the seat faces.
 * For table anchors the table top goes ~50 cm below eye level (0.6–1.05 m), so it suits both
 * sitting and standing users; floor anchors sit on the local floor.
 */
export function frameInFrontOfViewer(head: Vector3, headQuat: Quaternion, seat: SeatSpec, anchor: AnchorSpec): Matrix4 {
  const fwd = new Vector3(0, 0, -1).applyQuaternion(headQuat);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const [sfx, sfz] = seatForward(seat.yaw);
  const yaw = heading(fwd.x, fwd.z) - heading(sfx, sfz);
  const r = new Vector3(seat.x, 0, seat.z).applyAxisAngle(UP, yaw);
  const origin = new Vector3(head.x - r.x, 0, head.z - r.z);
  origin.y = anchor.kind === 'table' ? Math.min(Math.max(head.y - 0.5, 0.6), 1.05) : 0;
  return compose(origin, yaw);
}

/** Desktop: the local origin is the floor and the room anchor sits floorOffset above it. */
export function desktopFrame(anchor: AnchorSpec): Matrix4 {
  return compose(new Vector3(0, anchor.floorOffset, 0), 0);
}

export type CalibrationKind = 'auto' | 'one-point' | 'two-point' | 'desktop';

export class SharedFrame {
  readonly root = new Group();
  kind: CalibrationKind = 'desktop';
  /** Whether an XRAnchor is keeping the frame aligned (shown in the UI). */
  anchored = false;

  private anchor: XRAnchor | null = null;
  private pendingAnchor: Matrix4 | null = null;
  private generation = 0;

  constructor() {
    this.root.name = 'sharedRoot';
    this.root.matrixAutoUpdate = false;
    this.set(desktopFrame({ kind: 'table', floorOffset: 0.72 }), 'desktop');
  }

  /** Apply a new calibration. In XR, an anchor is created on the next frame. */
  set(localFromShared: Matrix4, kind: CalibrationKind, useAnchor = false): void {
    this.kind = kind;
    this.root.matrix.copy(localFromShared);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    this.dropAnchor();
    this.pendingAnchor = useAnchor ? localFromShared.clone() : null;
  }

  /** Call every frame. Anchors can only be created inside an XRFrame, so that happens here. */
  update(frame: XRFrame | undefined, refSpace: XRReferenceSpace | null): void {
    if (!frame || !refSpace) return;
    if (this.pendingAnchor && typeof frame.createAnchor === 'function') {
      const m = this.pendingAnchor;
      this.pendingAnchor = null;
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, new Vector3());
      const gen = ++this.generation;
      frame
        .createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), refSpace)
        ?.then((anchor) => {
          if (gen !== this.generation) {
            anchor.delete(); // recalibrated in the meantime
            return;
          }
          this.anchor = anchor;
          this.anchored = true;
        })
        .catch((e: unknown) => console.warn('[colo] createAnchor failed', e));
    }
    if (this.anchor) {
      // Move the shared frame along with the device's tracking corrections (relocalization).
      if (!frame.trackedAnchors || frame.trackedAnchors.has(this.anchor)) {
        const pose = frame.getPose(this.anchor.anchorSpace, refSpace);
        if (pose) {
          this.root.matrix.fromArray(pose.transform.matrix);
          this.root.matrixWorldNeedsUpdate = true;
        }
      }
    }
  }

  /** Call when the anchor becomes invalid, e.g. when the XR session ends. */
  dropAnchor(): void {
    this.generation++;
    try {
      this.anchor?.delete();
    } catch {
      // delete() may fail once the session has ended
    }
    this.anchor = null;
    this.anchored = false;
  }
}
