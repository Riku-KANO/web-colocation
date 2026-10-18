import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { seatAt } from '../shared/protocol.ts';
import { frameFromOnePoint, frameFromTwoPoints, frameInFrontOfViewer } from '../src/sync/sharedFrame.ts';

const toLocal = (m: Matrix4, x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m);
const toShared = (m: Matrix4, v: Vector3) => v.clone().applyMatrix4(m.clone().invert());

function expectClose(a: Vector3, b: Vector3, eps = 1e-6) {
  expect(a.distanceTo(b)).toBeLessThan(eps);
}

/** 任意の剛体変換 (端末ごとに違うローカル参照空間を模擬)。 */
function deviceSpace(yaw: number, tx: number, tz: number): Matrix4 {
  return new Matrix4().compose(
    new Vector3(tx, 0, tz),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
    new Vector3(1, 1, 1),
  );
}

describe('frameFromTwoPoints (同室キャリブレーション)', () => {
  it('原点は中点、+X は A→B 方向', () => {
    const a = new Vector3(1, 0.7, 2);
    const b = new Vector3(1, 0.74, 0); // A から -Z 方向
    const m = frameFromTwoPoints(a, b);
    expectClose(toLocal(m, 0, 0, 0), new Vector3(1, 0.72, 1));
    const xAxis = toLocal(m, 1, 0, 0).sub(toLocal(m, 0, 0, 0));
    expectClose(xAxis, new Vector3(0, 0, -1));
  });

  it('2 台の端末が同じ物理点をタッチすれば、共有座標が物理的に一致する', () => {
    // 物理空間の 2 点 (テーブル短辺の中点)
    const physA = new Vector3(-0.7, 0.72, 0.3);
    const physB = new Vector3(0.7, 0.72, 0.1);
    // 端末ごとに原点も向きも違うローカル空間: local = D⁻¹ · physical
    const devices = [deviceSpace(0.3, 2, -1), deviceSpace(-2.1, -0.5, 4)];
    const sharedOfSomePhysicalPoint = devices.map((d) => {
      const inv = d.clone().invert();
      const m = frameFromTwoPoints(physA.clone().applyMatrix4(inv), physB.clone().applyMatrix4(inv));
      // 物理空間のある点 (たとえば相手の頭) を各端末の共有座標で表す
      const head = new Vector3(0.2, 1.2, 0.9).applyMatrix4(inv);
      return toShared(m, head);
    });
    expectClose(sharedOfSomePhysicalPoint[0], sharedOfSomePhysicalPoint[1], 1e-6);
  });
});

describe('frameFromOnePoint (リモート: 各自の机)', () => {
  it('自分のいる方向が、共有座標系での自分の席の方向になる', () => {
    for (const seatIndex of [0, 1, 2]) {
      const seat = seatAt(seatIndex);
      const point = new Vector3(3, 0.7, -2);
      const viewer = new Vector3(5, 1.2, -2); // 机の +X 側に座っている
      const m = frameFromOnePoint(point, viewer, seat);
      expectClose(toLocal(m, 0, 0, 0), point);
      const v = toShared(m, viewer);
      const dirShared = Math.atan2(v.x, v.z);
      expect(Math.abs(Math.sin(dirShared - Math.atan2(seat.x, seat.z)))).toBeLessThan(1e-9);
      expect(Math.cos(dirShared - Math.atan2(seat.x, seat.z))).toBeGreaterThan(0);
    }
  });

  it('向かい合う 2 人 (席 0 と 1) は、共有空間でもテーブルを挟んで向かい合う', () => {
    // 2 人は別々の部屋で、それぞれ自分の机の手前に座っている
    const alice = frameFromOnePoint(new Vector3(0, 0.7, -0.6), new Vector3(0, 1.2, 0), seatAt(0));
    const bob = frameFromOnePoint(new Vector3(10, 0.75, 5), new Vector3(10.5, 1.15, 5.1), seatAt(1));
    const aliceHead = toShared(alice, new Vector3(0, 1.2, 0));
    const bobHead = toShared(bob, new Vector3(10.5, 1.15, 5.1));
    expect(aliceHead.z).toBeGreaterThan(0.3);
    expect(bobHead.z).toBeLessThan(-0.3);
  });
});

describe('frameInFrontOfViewer', () => {
  it('頭の正面・水平に机を置き、天板の高さを常識的な範囲に収める', () => {
    const head = new Vector3(0, 1.6, 0);
    const lookingRight = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2); // -Z → +X
    const m = frameInFrontOfViewer(head, lookingRight, seatAt(0));
    const origin = toLocal(m, 0, 0, 0);
    expect(origin.x).toBeGreaterThan(0.5);
    expect(Math.abs(origin.z)).toBeLessThan(1e-6);
    expect(origin.y).toBeGreaterThanOrEqual(0.6);
    expect(origin.y).toBeLessThanOrEqual(1.05);
  });
});
