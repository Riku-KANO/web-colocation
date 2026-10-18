import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { AnchorSpec, SeatSpec } from '../shared/roomConfig.ts';
import { seatForward } from '../shared/roomConfig.ts';
import { frameFromOnePoint, frameFromTwoPoints, frameInFrontOfViewer } from '../src/sync/sharedFrame.ts';
import { roomConfig } from './helpers.ts';

const STANDARD = roomConfig();
const seatAt = (i: number): SeatSpec => STANDARD.seats[i];
const TABLE: AnchorSpec = STANDARD.anchor;
const FLOOR: AnchorSpec = { kind: 'floor', floorOffset: 0 };

const toLocal = (m: Matrix4, x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m);
const toShared = (m: Matrix4, v: Vector3) => v.clone().applyMatrix4(m.clone().invert());

function expectClose(a: Vector3, b: Vector3, eps = 1e-6) {
  expect(a.distanceTo(b)).toBeLessThan(eps);
}

/** Arbitrary rigid transform (simulates each device's different local reference space). */
function deviceSpace(yaw: number, tx: number, tz: number): Matrix4 {
  return new Matrix4().compose(
    new Vector3(tx, 0, tz),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
    new Vector3(1, 1, 1),
  );
}

describe('frameFromTwoPoints (same-room calibration)', () => {
  it('puts the origin at the midpoint with +X pointing from A to B', () => {
    const a = new Vector3(1, 0.7, 2);
    const b = new Vector3(1, 0.74, 0); // -Z from A
    const m = frameFromTwoPoints(a, b);
    expectClose(toLocal(m, 0, 0, 0), new Vector3(1, 0.72, 1));
    const xAxis = toLocal(m, 1, 0, 0).sub(toLocal(m, 0, 0, 0));
    expectClose(xAxis, new Vector3(0, 0, -1));
  });

  it('makes shared coordinates match physically when two devices touch the same points', () => {
    // Two physical points (midpoints of the table's short edges).
    const physA = new Vector3(-0.7, 0.72, 0.3);
    const physB = new Vector3(0.7, 0.72, 0.1);
    // Each device's local space has its own origin and heading: local = D⁻¹ · physical
    const devices = [deviceSpace(0.3, 2, -1), deviceSpace(-2.1, -0.5, 4)];
    const sharedOfSomePhysicalPoint = devices.map((d) => {
      const inv = d.clone().invert();
      const m = frameFromTwoPoints(physA.clone().applyMatrix4(inv), physB.clone().applyMatrix4(inv));
      // Express one physical point (e.g. the other person's head) in each device's shared frame.
      const head = new Vector3(0.2, 1.2, 0.9).applyMatrix4(inv);
      return toShared(m, head);
    });
    expectClose(sharedOfSomePhysicalPoint[0], sharedOfSomePhysicalPoint[1], 1e-6);
  });
});

describe('frameFromOnePoint (remote: each at their own desk)', () => {
  it('maps the direction toward the viewer to the direction of their seat in the shared frame', () => {
    for (const seatIndex of [0, 1, 2]) {
      const seat = seatAt(seatIndex);
      const point = new Vector3(3, 0.7, -2);
      const viewer = new Vector3(5, 1.2, -2); // sitting on the +X side of the desk
      const m = frameFromOnePoint(point, viewer, seat, TABLE);
      expectClose(toLocal(m, 0, 0, 0), point);
      const v = toShared(m, viewer);
      const dirShared = Math.atan2(v.x, v.z);
      expect(Math.abs(Math.sin(dirShared - Math.atan2(seat.x, seat.z)))).toBeLessThan(1e-9);
      expect(Math.cos(dirShared - Math.atan2(seat.x, seat.z))).toBeGreaterThan(0);
    }
  });

  it('keeps two people facing each other (seats 0 and 1) across the table in the shared space', () => {
    // The two are in separate rooms, each sitting in front of their own desk.
    const alice = frameFromOnePoint(new Vector3(0, 0.7, -0.6), new Vector3(0, 1.2, 0), seatAt(0), TABLE);
    const bob = frameFromOnePoint(new Vector3(10, 0.75, 5), new Vector3(10.5, 1.15, 5.1), seatAt(1), TABLE);
    const aliceHead = toShared(alice, new Vector3(0, 1.2, 0));
    const bobHead = toShared(bob, new Vector3(10.5, 1.15, 5.1));
    expect(aliceHead.z).toBeGreaterThan(0.3);
    expect(bobHead.z).toBeLessThan(-0.3);
  });
});

describe('frameInFrontOfViewer', () => {
  it('puts the viewer at their seat, looking the way the seat faces, with a sensible table height', () => {
    const head = new Vector3(0.3, 1.6, -0.2);
    const lookingRight = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2); // -Z → +X
    for (const i of [0, 1, 2]) {
      const seat = seatAt(i);
      const m = frameInFrontOfViewer(head, lookingRight, seat, TABLE);
      const sharedHead = toShared(m, head);
      expect(Math.hypot(sharedHead.x - seat.x, sharedHead.z - seat.z)).toBeLessThan(1e-6);
      // the viewer's forward (+X in local space) maps to the seat's forward in the shared frame
      const fwd = toShared(m, head.clone().add(new Vector3(1, 0, 0))).sub(sharedHead);
      const [fx, fz] = seatForward(seat.yaw);
      expect(fwd.x).toBeCloseTo(fx);
      expect(fwd.z).toBeCloseTo(fz);
      const origin = toLocal(m, 0, 0, 0);
      expect(origin.y).toBeGreaterThanOrEqual(0.6);
      expect(origin.y).toBeLessThanOrEqual(1.05);
    }
  });

  it('floor anchors sit on the local floor', () => {
    const m = frameInFrontOfViewer(new Vector3(0, 1.7, 0), new Quaternion(), { x: 0, z: 1, yaw: 0 }, FLOOR);
    expect(toLocal(m, 0, 0, 0).y).toBe(0);
    expect(toLocal(m, 0, 0, 0).z).toBeCloseTo(-1);
  });
});
