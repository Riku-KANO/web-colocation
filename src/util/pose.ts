import { Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type { Pose } from '../../shared/protocol.ts';

const _m = new Matrix4();
const _s = new Vector3();

/** 小数点以下を丸めてネットワーク送信量を抑える (0.1 mm / 1e-5)。 */
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
 * ワールド行列を共有座標系に変換する。
 * sharedRoot はシーン直下にあり、その行列が「ローカル(XR 参照空間) ← 共有」の変換。
 */
export function worldToShared(world: Matrix4, sharedRoot: Object3D, outP: Vector3, outQ: Quaternion): void {
  _m.copy(sharedRoot.matrixWorld).invert().multiply(world);
  _m.decompose(outP, outQ, _s);
}

export function pointWorldToShared(world: Vector3, sharedRoot: Object3D, out: Vector3): Vector3 {
  _m.copy(sharedRoot.matrixWorld).invert();
  return out.copy(world).applyMatrix4(_m);
}

/** フレームレートに依存しない指数平滑化の係数。rate が大きいほど速く追従する。 */
export function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function objectWorldPose(obj: Object3D, outP: Vector3, outQ: Quaternion): void {
  obj.matrixWorld.decompose(outP, outQ, _s);
}
