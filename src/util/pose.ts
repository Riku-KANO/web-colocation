import { Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type { Pose } from '../../shared/protocol.ts';

const _m = new Matrix4();
const _s = new Vector3();

/** Rounds off decimals to keep network payloads small (0.1 mm / 1e-5). */
const round = (x: number, k: number) => Math.round(x * k) / k;

export function toPose(p: Vector3, q: Quaternion): Pose {
  return {
    p: [round(p.x, 1e4), round(p.y, 1e4), round(p.z, 1e4)],
    q: [round(q.x, 1e5), round(q.y, 1e5), round(q.z, 1e5), round(q.w, 1e5)],
  };
}

export function readPose(pose: Pose, p: Vector3, q: Quaternion): void {
  p.fromArray(pose.p);
  q.fromArray(pose.q).normalize();
}

/**
 * Converts a world matrix into the shared frame.
 * sharedRoot sits directly under the scene, and its matrix is the "local (XR reference space) ← shared" transform.
 */
export function worldToShared(world: Matrix4, sharedRoot: Object3D, outP: Vector3, outQ: Quaternion): void {
  _m.copy(sharedRoot.matrixWorld).invert().multiply(world);
  _m.decompose(outP, outQ, _s);
}

export function pointWorldToShared(world: Vector3, sharedRoot: Object3D, out: Vector3): Vector3 {
  _m.copy(sharedRoot.matrixWorld).invert();
  return out.copy(world).applyMatrix4(_m);
}

/** Frame-rate-independent exponential smoothing factor; a higher rate follows faster. */
export function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function objectWorldPose(obj: Object3D, outP: Vector3, outQ: Quaternion): void {
  obj.matrixWorld.decompose(outP, outQ, _s);
}
