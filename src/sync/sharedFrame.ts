// 共有座標系 (shared frame) の管理。
//
// 各端末の WebXR 参照空間 (local-floor) は端末ごとに原点も向きもバラバラ。
// そこで「ローカル ← 共有」の剛体変換 M を端末ごとに求め、共有コンテンツは
// すべて sharedRoot (行列 = M) の子として置く。ネットワークには共有座標系の値だけが流れる。
//
//   - 別々の部屋 (リモート):   各自が自分の机の上に 1 点でテーブルを置く → 着席方向で回転を決める
//   - 同じ部屋 (コロケーション): 全員が同じ物理的な 2 点を同じ順番でタッチ → 物理空間と一致する
//
// WebXR には共有アンカー/クラウドアンカーの標準 API がないため、この「手動キャリブレーション」を
// すべてのブラウザで動く最小公倍数として採用している。キャリブ後は XRAnchor (対応端末のみ) で
// トラッキングの再ローカライズによるズレに追従させる。

import { Group, Matrix4, Quaternion, Vector3 } from 'three';
import { TABLE, type Seat } from '../../shared/protocol.ts';

const UP = new Vector3(0, 1, 0);

/** ベクトルの水平方向の角度 (+Z から +X 方向へ測る)。R_y(θ) はこの角度に θ を足す。 */
function heading(x: number, z: number): number {
  return Math.atan2(x, z);
}

function compose(origin: Vector3, yaw: number): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(UP, yaw);
  return new Matrix4().compose(origin, q, new Vector3(1, 1, 1));
}

/**
 * 1 点キャリブレーション (リモート用)。
 * point をテーブル天板の中心とし、「point → 自分の頭」の水平方向が、共有座標系での
 * 「原点 → 自分の席」の方向と一致するように回転を決める。
 */
export function frameFromOnePoint(point: Vector3, viewer: Vector3, seat: Seat): Matrix4 {
  let dx = viewer.x - point.x;
  let dz = viewer.z - point.z;
  if (Math.hypot(dx, dz) < 1e-3) {
    dx = seat.x;
    dz = seat.z;
  }
  const yaw = heading(dx, dz) - heading(seat.x, seat.z);
  return compose(point, yaw);
}

/**
 * 2 点キャリブレーション (同室用)。
 * 原点 = 2 点の中点、共有座標系の +X = A→B の水平方向。高さは 2 点の平均 (= 天板面)。
 * 例: テーブルの左右の短辺の中点を A, B としてタッチすれば、原点がテーブル中心になる。
 */
export function frameFromTwoPoints(a: Vector3, b: Vector3): Matrix4 {
  const origin = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // R_y(θ)·(1,0,0) = (cosθ, 0, -sinθ) を (dx, dz) の向きに合わせる
  const yaw = Math.atan2(-dz, dx);
  return compose(origin, yaw);
}

/** XR 開始直後の仮配置: 頭の正面・席の距離にテーブルを置く。 */
export function frameInFrontOfViewer(head: Vector3, headQuat: Quaternion, seat: Seat): Matrix4 {
  const fwd = new Vector3(0, 0, -1).applyQuaternion(headQuat);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const dist = Math.max(0.5, Math.hypot(seat.x, seat.z));
  const center = head.clone().addScaledVector(fwd, dist);
  // 座っていれば目線の 45cm 下、立っていれば 1m 前後の高さに天板
  center.y = Math.min(Math.max(head.y - 0.5, 0.6), 1.05);
  return frameFromOnePoint(center, head, seat);
}

/** デスクトップ用: ローカル原点 = 床、テーブル中心がその真上。 */
export function desktopFrame(): Matrix4 {
  return compose(new Vector3(0, TABLE.height, 0), 0);
}

export type CalibrationKind = 'auto' | 'one-point' | 'two-point' | 'desktop';

export class SharedFrame {
  readonly root = new Group();
  kind: CalibrationKind = 'desktop';
  /** XRAnchor で追従中か (UI 表示用)。 */
  anchored = false;

  private anchor: XRAnchor | null = null;
  private pendingAnchor: Matrix4 | null = null;
  private generation = 0;

  constructor() {
    this.root.name = 'sharedRoot';
    this.root.matrixAutoUpdate = false;
    this.set(desktopFrame(), 'desktop');
  }

  /** 新しいキャリブレーション結果を適用する。XR 中なら次のフレームでアンカーを張る。 */
  set(localFromShared: Matrix4, kind: CalibrationKind, useAnchor = false): void {
    this.kind = kind;
    this.root.matrix.copy(localFromShared);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    this.dropAnchor();
    this.pendingAnchor = useAnchor ? localFromShared.clone() : null;
  }

  /** 毎フレーム呼ぶ。XRFrame 内でしかアンカーを作れないのでここで処理する。 */
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
            anchor.delete(); // その間に再キャリブされた
            return;
          }
          this.anchor = anchor;
          this.anchored = true;
        })
        .catch((e: unknown) => console.warn('[colo] createAnchor failed', e));
    }
    if (this.anchor) {
      // 端末のトラッキング補正 (再ローカライズ) に合わせて共有座標系を動かす
      if (!frame.trackedAnchors || frame.trackedAnchors.has(this.anchor)) {
        const pose = frame.getPose(this.anchor.anchorSpace, refSpace);
        if (pose) {
          this.root.matrix.fromArray(pose.transform.matrix);
          this.root.matrixWorldNeedsUpdate = true;
        }
      }
    }
  }

  /** XR セッション終了時など、アンカーが無効になるときに呼ぶ。 */
  dropAnchor(): void {
    this.generation++;
    try {
      this.anchor?.delete();
    } catch {
      // セッション終了後の delete は失敗してよい
    }
    this.anchor = null;
    this.anchored = false;
  }
}
