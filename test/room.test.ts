import { describe, expect, it } from 'vitest';
import { parseClientMsg } from '../shared/validate.ts';
import { Room } from '../server/room.ts';
import { FakePeer, join, pose, roomConfig } from './helpers.ts';

const E = 1; // initial room epoch

function setup(hostMode: 'first-joiner' | 'configured' = 'first-joiner') {
  const room = new Room(roomConfig(), { hostMode });
  const a = new FakePeer('A');
  const b = new FakePeer('B');
  room.join(a.id, a, join('Alice'));
  room.join(b.id, b, join('Bob'));
  a.clear();
  b.clear();
  return { room, a, b };
}

describe('Room', () => {
  it('assigns seats in order, sends the config and a snapshot, and reuses freed seats', () => {
    const room = new Room(roomConfig());
    const a = new FakePeer('A');
    const b = new FakePeer('B');
    expect(room.join(a.id, a, join('Alice')).seat).toBe(0);
    expect(room.join(b.id, b, join('Bob')).seat).toBe(1);
    const w = b.last('welcome')!;
    expect(w.config.template).toBe('standard');
    expect(w.epoch).toBe(1);
    expect(w.snapshot.peers.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(w.snapshot.objects.length).toBeGreaterThan(0);
    expect(a.last('peer-join')?.peer.name).toBe('Bob');
    room.leave('A');
    const c = new FakePeer('C');
    expect(room.join(c.id, c, join('Carol')).seat).toBe(0);
  });

  it('is full when every seat (or maxParticipants) is taken — seats never wrap around', () => {
    const config = roomConfig();
    config.rules.maxParticipants = 3;
    const room = new Room(config);
    for (const id of ['A', 'B', 'C']) {
      expect(room.admissionError()).toBeNull();
      room.join(id, new FakePeer(id), join(id));
    }
    expect(room.admissionError()).toBe('room-full');
    const seats = room.snapshot().peers.map((p) => p.seat);
    expect(new Set(seats).size).toBe(3);
  });

  it('only the owner can move an object and others receive the moves', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'grab', e: E, id: 'cube' });
    expect(a.last('owner')).toMatchObject({ id: 'cube', owner: 'A' });
    expect(b.last('owner')).toMatchObject({ id: 'cube', owner: 'A' });
    room.handle('A', { t: 'move', e: E, id: 'cube', pose: pose(0.3) });
    expect(b.last('move')?.pose.p[0]).toBe(0.3);
    expect(a.last('move')).toBeUndefined();
    b.clear();
    room.handle('B', { t: 'move', e: E, id: 'cube', pose: pose(-1) });
    expect(a.last('move')).toBeUndefined();
    expect(room.snapshot().objects.find((o) => o.id === 'cube')!.pose.p[0]).toBe(0.3);
  });

  it('first grab wins; the loser gets grab-denied with the current pose', () => {
    const { room, b } = setup();
    room.handle('A', { t: 'grab', e: E, id: 'sphere' });
    room.handle('B', { t: 'grab', e: E, id: 'sphere' });
    expect(b.last('grab-denied')).toMatchObject({ id: 'sphere', owner: 'A' });
  });

  it('release settles the pose and frees the object; disconnecting releases held objects', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'grab', e: E, id: 'cube' });
    room.handle('A', { t: 'release', e: E, id: 'cube', pose: pose(0.5) });
    expect(b.last('owner')).toMatchObject({ id: 'cube', owner: null, pose: { p: [0.5, 0.05, 0] } });
    room.handle('B', { t: 'grab', e: E, id: 'torus' });
    room.leave('B');
    expect(a.all('owner').some((m) => m.id === 'torus' && m.owner === null)).toBe(true);
  });

  it('drops messages from an old epoch', () => {
    const { room, b } = setup();
    room.handle('A', { t: 'grab', e: E + 5, id: 'cube' });
    expect(b.last('owner')).toBeUndefined();
  });

  it('strokes: only the author appends, unknown boards are rejected, late joiners get them', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'stroke', e: E, id: 'A-1', board: 'nope', color: '#000000', width: 0.004, pts: [0.1, 0.1] });
    expect(b.last('stroke')).toBeUndefined();
    room.handle('A', { t: 'stroke', e: E, id: 'A-1', board: 'wb1', color: '#000000', width: 0.004, pts: [0.1, 0.1] });
    room.handle('A', { t: 'stroke-pts', e: E, id: 'A-1', pts: [0.2, 0.2, 0.3, 0.3] });
    room.handle('B', { t: 'stroke-pts', e: E, id: 'A-1', pts: [0.9, 0.9] });
    room.handle('A', { t: 'stroke-end', e: E, id: 'A-1' });
    expect(b.last('stroke-pts')?.pts).toEqual([0.2, 0.2, 0.3, 0.3]);
    expect(a.last('stroke-pts')).toBeUndefined();
    const c = new FakePeer('C');
    room.join(c.id, c, join('Carol'));
    expect(c.last('welcome')!.snapshot.strokes[0]).toMatchObject({ pts: [0.1, 0.1, 0.2, 0.2, 0.3, 0.3], done: true });
    room.handle('B', { t: 'board-clear', e: E, board: 'wb1' });
    expect(a.last('board-clear')).toMatchObject({ board: 'wb1' });
    expect(room.snapshot().strokes).toHaveLength(0);
  });

  it('first joiner is host in ad-hoc rooms and the role passes on when they leave', () => {
    const { room, a } = setup();
    const peers = room.snapshot().peers;
    expect(peers.find((p) => p.id === 'A')?.role).toBe('host');
    expect(peers.find((p) => p.id === 'B')?.role).toBe('member');
    room.leave('A');
    expect(room.snapshot().peers[0]).toMatchObject({ id: 'B', role: 'host' });
    expect(a.last('peer-update')).toBeUndefined(); // A is gone
  });

  it('in configured rooms only configured hosts are hosts', () => {
    const room = new Room(roomConfig(), { hostMode: 'configured' });
    room.join('A', new FakePeer('A'), join('Alice'));
    room.join('H', new FakePeer('H'), join('Host', { configuredHost: true }));
    const roles = Object.fromEntries(room.snapshot().peers.map((p) => [p.id, p.role]));
    expect(roles).toEqual({ A: 'member', H: 'host' });
  });

  it('enforces host-only permissions', () => {
    const config = roomConfig();
    config.rules.permissions.clearBoard = 'hosts';
    config.rules.permissions.resetObjects = 'hosts';
    const room = new Room(config);
    const a = new FakePeer('A');
    const b = new FakePeer('B');
    room.join('A', a, join('Alice')); // host (first joiner)
    room.join('B', b, join('Bob'));
    room.handle('B', { t: 'board-clear', e: E, board: 'wb1' });
    expect(b.last('error')).toMatchObject({ code: 'not-allowed' });
    expect(a.last('board-clear')).toBeUndefined();
    room.handle('A', { t: 'reset-objects', e: E });
    expect(b.last('objects')).toBeDefined();
  });

  it('reconfigure releases held objects, drops strokes on removed boards, keeps seats and bumps the epoch', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'grab', e: E, id: 'cube' });
    room.handle('A', { t: 'stroke', e: E, id: 'A-1', board: 'wb1', color: '#000000', width: 0.004, pts: [0.1, 0.1] });
    room.reconfigure(roomConfig('r', 'workshop'));
    const msg = b.last('config')!;
    expect(msg.epoch).toBe(2);
    expect(msg.config.template).toBe('workshop');
    expect(msg.self.id).toBe('B');
    expect(msg.snapshot.objects.every((o) => o.owner === null)).toBe(true);
    expect(msg.snapshot.strokes.map((s) => s.id)).toEqual(['A-1']); // workshop also has wb1
    expect(a.last('config')!.self.seat).toBe(0);
    // A grab from the old epoch is ignored after the switch.
    room.handle('B', { t: 'grab', e: E, id: 'cube' });
    expect(room.snapshot().objects.find((o) => o.id === 'cube')!.owner).toBeNull();
    room.reconfigure(roomConfig('r', 'presentation'));
    expect(b.last('config')!.snapshot.strokes).toHaveLength(0);
  });

  it('exports and imports persistent state', () => {
    const { room } = setup();
    room.handle('A', { t: 'grab', e: E, id: 'cube' });
    room.handle('A', { t: 'release', e: E, id: 'cube', pose: pose(0.42) });
    room.handle('A', { t: 'stroke', e: E, id: 'A-1', board: 'wb1', color: '#000000', width: 0.004, pts: [0.1, 0.1] });
    room.handle('A', { t: 'stroke-end', e: E, id: 'A-1' });
    const state = room.exportState();
    const restored = new Room(roomConfig());
    restored.importState(state);
    const snap = restored.snapshot();
    expect(snap.objects.find((o) => o.id === 'cube')!.pose.p[0]).toBe(0.42);
    expect(snap.strokes).toHaveLength(1);
  });
});

describe('parseClientMsg', () => {
  it('rejects malformed or oversized input', () => {
    expect(parseClientMsg({ t: 'move', e: 1, id: 'cube', pose: { p: [0, 0, NaN], q: [0, 0, 0, 1] } })).toBeNull();
    expect(parseClientMsg({ t: 'move', e: 1, id: 'cube', pose: { p: [0, 0, 0], q: [0, 0, 0, 0] } })).toBeNull();
    expect(parseClientMsg({ t: 'move', id: 'cube', pose: { p: [0, 0, 0], q: [0, 0, 0, 1] } })).toBeNull(); // no epoch
    expect(parseClientMsg({ t: 'stroke-pts', e: 1, id: 's', pts: new Array(5000).fill(0.5) })).toBeNull();
    expect(parseClientMsg({ t: 'hello', v: 3, room: 'r', name: 'x', color: 'red', device: 'desktop', space: '' })).toBeNull();
    expect(parseClientMsg({ t: 'nope' })).toBeNull();
    expect(parseClientMsg('{"t":"ping"}')).toBeNull();
  });

  it('normalizes quaternions and validates host settings', () => {
    expect(parseClientMsg({ t: 'move', e: 1, id: 'cube', pose: { p: [0, 0, 0], q: [0, 0, 0, 0.9] } })).toMatchObject({ pose: { q: [0, 0, 0, 1] } });
    expect(parseClientMsg({ t: 'room-settings', e: 1, settings: { template: 'workshop', rules: { permissions: { clearBoard: 'hosts' } } } })).toMatchObject({
      settings: { template: 'workshop', rules: { permissions: { clearBoard: 'hosts' } } },
    });
    expect(parseClientMsg({ t: 'room-settings', e: 1, settings: { rules: { permissions: { clearBoard: 'admins' } } } })).toBeNull();
    expect(parseClientMsg({ t: 'room-settings', e: 1, settings: { title: '   ' } })).toBeNull();
  });
});
