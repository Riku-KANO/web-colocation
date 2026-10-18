import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol.ts';
import { LIMITS, parseClientMsg } from '../shared/validate.ts';
import { Room } from '../server/room.ts';

class FakePeer {
  readonly inbox: ServerMsg[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  send(data: string) {
    this.inbox.push(JSON.parse(data) as ServerMsg);
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
  clear() {
    this.inbox.length = 0;
  }
}

const hello = (name: string): Extract<ClientMsg, { t: 'hello' }> => ({
  t: 'hello',
  v: PROTOCOL_VERSION,
  room: 'r',
  name,
  color: '#112233',
  device: 'desktop',
  space: '',
});

const pose = (x: number) => ({ p: [x, 0.05, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] });

function setup() {
  const room = new Room('r');
  const a = new FakePeer('A');
  const b = new FakePeer('B');
  room.join(a.id, a, hello('Alice'));
  room.join(b.id, b, hello('Bob'));
  a.clear();
  b.clear();
  return { room, a, b };
}

describe('Room', () => {
  it('参加者に席を順に割り当て、スナップショットを送る', () => {
    const room = new Room('r');
    const a = new FakePeer('A');
    const b = new FakePeer('B');
    expect(room.join(a.id, a, hello('Alice')).seat).toBe(0);
    expect(room.join(b.id, b, hello('Bob')).seat).toBe(1);
    const w = b.last('welcome')!;
    expect(w.snapshot.peers.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(w.snapshot.objects.length).toBeGreaterThan(0);
    expect(a.last('peer-join')?.peer.name).toBe('Bob');
    room.leave('A');
    const c = new FakePeer('C');
    expect(room.join(c.id, c, hello('Carol')).seat).toBe(0); // 空いた席を再利用
  });

  it('所有者だけが動かせ、他の人には move が届く', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'grab', id: 'cube' });
    expect(a.last('owner')).toMatchObject({ id: 'cube', owner: 'A' });
    expect(b.last('owner')).toMatchObject({ id: 'cube', owner: 'A' });

    room.handle('A', { t: 'move', id: 'cube', pose: pose(0.3) });
    expect(b.last('move')?.pose.p[0]).toBe(0.3);
    expect(a.last('move')).toBeUndefined(); // 送り主には返さない

    b.clear();
    room.handle('B', { t: 'move', id: 'cube', pose: pose(-1) }); // 所有者でない
    expect(a.last('move')).toBeUndefined();
    expect(room.snapshot().objects.find((o) => o.id === 'cube')!.pose.p[0]).toBe(0.3);
  });

  it('同時に掴もうとしたら先着が勝ち、後着には grab-denied と現在の姿勢が返る', () => {
    const { room, b } = setup();
    room.handle('A', { t: 'grab', id: 'sphere' });
    room.handle('B', { t: 'grab', id: 'sphere' });
    const denied = b.last('grab-denied');
    expect(denied).toMatchObject({ id: 'sphere', owner: 'A' });
    expect(denied?.pose.p).toBeDefined();
  });

  it('離すと最終姿勢つきで所有権が解放され、他の人が掴める', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'grab', id: 'cube' });
    room.handle('A', { t: 'release', id: 'cube', pose: pose(0.5) });
    expect(b.last('owner')).toMatchObject({ id: 'cube', owner: null, pose: { p: [0.5, 0.05, 0] } });
    room.handle('B', { t: 'grab', id: 'cube' });
    expect(a.last('owner')).toMatchObject({ id: 'cube', owner: 'B' });
  });

  it('掴んだまま切断されたら所有権を解放する', () => {
    const { room, b } = setup();
    room.handle('A', { t: 'grab', id: 'cube' });
    room.leave('A');
    expect(b.inbox.some((m) => m.t === 'owner' && m.owner === null && m.id === 'cube')).toBe(true);
    expect(b.last('peer-leave')?.id).toBe('A');
    room.handle('B', { t: 'grab', id: 'cube' });
    expect(b.last('owner')).toMatchObject({ owner: 'B' });
  });

  it('ストロークは作者だけが追記でき、途中参加者にも全体が届く', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'stroke', id: 'A-1', board: 'wb1', color: '#000000', width: 0.004, pts: [0.1, 0.1] });
    room.handle('A', { t: 'stroke-pts', id: 'A-1', pts: [0.2, 0.2, 0.3, 0.3] });
    room.handle('B', { t: 'stroke-pts', id: 'A-1', pts: [0.9, 0.9] }); // 作者でない
    room.handle('A', { t: 'stroke-end', id: 'A-1' });
    expect(b.last('stroke')?.stroke.pts).toEqual([0.1, 0.1]);
    expect(b.last('stroke-pts')?.pts).toEqual([0.2, 0.2, 0.3, 0.3]);
    expect(a.last('stroke-pts')).toBeUndefined();

    const c = new FakePeer('C');
    room.join(c.id, c, hello('Carol'));
    const s = c.last('welcome')!.snapshot.strokes[0];
    expect(s.pts).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    expect(s.done).toBe(true);

    room.handle('B', { t: 'board-clear', board: 'wb1' });
    expect(a.last('board-clear')).toMatchObject({ board: 'wb1' });
    expect(room.snapshot().strokes).toHaveLength(0);
  });

  it('reset-objects は誰かが掴んでいる物を除いて初期配置に戻す', () => {
    const { room, b } = setup();
    room.handle('A', { t: 'grab', id: 'cube' });
    room.handle('A', { t: 'move', id: 'cube', pose: pose(0.9) });
    room.handle('B', { t: 'grab', id: 'sphere' });
    room.handle('B', { t: 'release', id: 'sphere', pose: pose(0.8) });
    room.handle('B', { t: 'reset-objects' });
    const objs = b.last('objects')!.objects;
    expect(objs.find((o) => o.id === 'cube')!.pose.p[0]).toBe(0.9);
    expect(objs.find((o) => o.id === 'sphere')!.pose.p[0]).not.toBe(0.8);
  });
});

describe('Room: 音声', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
  const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };

  function voiceSetup() {
    const { room, a, b } = setup();
    const c = new FakePeer('C');
    room.join(c.id, c, hello('Carol'));
    room.handle('A', { t: 'voice', state: 'on' });
    room.handle('B', { t: 'voice', state: 'muted' });
    a.clear();
    b.clear();
    c.clear();
    return { room, a, b, c };
  }

  it('参加状態を peer-update で全員に配り、途中参加者にはスナップショットで渡す', () => {
    const { room, a, b } = setup();
    room.handle('A', { t: 'voice', state: 'on' });
    expect(b.last('peer-update')?.peer).toMatchObject({ id: 'A', voice: 'on' });
    expect(a.last('peer-update')?.peer).toMatchObject({ id: 'A', voice: 'on' }); // 自分にも返る
    b.clear();
    room.handle('A', { t: 'voice', state: 'on' }); // 変化なしなら配らない
    expect(b.last('peer-update')).toBeUndefined();

    const c = new FakePeer('C');
    room.join(c.id, c, { ...hello('Carol'), voice: 'muted' }); // 再接続した人は参加状態つきで入り直す
    const peers = c.last('welcome')!.snapshot.peers;
    expect(peers.find((p) => p.id === 'A')?.voice).toBe('on');
    expect(peers.find((p) => p.id === 'B')?.voice).toBe('off');
    expect(peers.find((p) => p.id === 'C')?.voice).toBe('muted');
  });

  it('rtc-offer / rtc-answer / rtc-ice を宛先にだけ from 付きで中継する', () => {
    const { room, a, b, c } = voiceSetup();
    room.handle('A', { t: 'rtc-offer', to: 'B', sdp });
    expect(b.last('rtc-offer')).toEqual({ t: 'rtc-offer', from: 'A', sdp });
    room.handle('B', { t: 'rtc-answer', to: 'A', sdp });
    expect(a.last('rtc-answer')).toEqual({ t: 'rtc-answer', from: 'B', sdp });
    room.handle('B', { t: 'rtc-ice', to: 'A', candidate });
    expect(a.last('rtc-ice')).toEqual({ t: 'rtc-ice', from: 'B', candidate });
    expect(c.inbox).toHaveLength(0);
    expect(a.last('rtc-offer')).toBeUndefined(); // 送り主には返さない
  });

  it('音声に参加していない人との間・存在しない宛先・自分宛ては中継しない', () => {
    const { room, a, b, c } = voiceSetup();
    room.handle('A', { t: 'rtc-offer', to: 'C', sdp }); // 宛先が不参加
    room.handle('C', { t: 'rtc-offer', to: 'A', sdp }); // 送り主が不参加
    room.handle('A', { t: 'rtc-offer', to: 'nobody', sdp });
    room.handle('A', { t: 'rtc-ice', to: 'A', candidate });
    expect([...a.inbox, ...b.inbox, ...c.inbox]).toHaveLength(0);

    // 退出した相手にも届かない (残った人には peer-leave だけ)
    room.leave('B');
    a.clear();
    room.handle('A', { t: 'rtc-offer', to: 'B', sdp });
    expect(a.inbox).toHaveLength(0);
    expect(b.last('rtc-offer')).toBeUndefined();

    // 音声を切った後も届かない
    room.handle('A', { t: 'voice', state: 'off' });
    room.handle('C', { t: 'voice', state: 'on' });
    c.clear();
    room.handle('A', { t: 'rtc-offer', to: 'C', sdp });
    expect(c.last('rtc-offer')).toBeUndefined();
  });
});

describe('parseClientMsg', () => {
  it('壊れた入力や巨大な入力を拒否する', () => {
    expect(parseClientMsg({ t: 'move', id: 'cube', pose: { p: [0, 0, NaN], q: [0, 0, 0, 1] } })).toBeNull();
    expect(parseClientMsg({ t: 'move', id: 'cube', pose: { p: [0, 0, 0], q: [0, 0, 0, 0] } })).toBeNull();
    expect(parseClientMsg({ t: 'stroke-pts', id: 's', pts: new Array(5000).fill(0.5) })).toBeNull();
    expect(parseClientMsg({ t: 'hello', v: 1, room: 'r', name: 'x', color: 'red', device: 'desktop', space: '' })).toBeNull();
    expect(parseClientMsg({ t: 'nope' })).toBeNull();
    expect(parseClientMsg('{"t":"ping"}')).toBeNull();
  });

  it('音声とシグナリングのメッセージを検証する', () => {
    const cand = { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' };
    expect(parseClientMsg({ t: 'voice', state: 'on' })).toEqual({ t: 'voice', state: 'on' });
    expect(parseClientMsg({ t: 'voice', state: 'loud' })).toBeNull();
    expect(parseClientMsg({ t: 'rtc-offer', to: 'B', sdp: 'v=0' })).toEqual({ t: 'rtc-offer', to: 'B', sdp: 'v=0' });
    expect(parseClientMsg({ t: 'rtc-answer', to: 'B', sdp: '' })).toBeNull();
    expect(parseClientMsg({ t: 'rtc-offer', sdp: 'v=0' })).toBeNull(); // 宛先なし
    expect(parseClientMsg({ t: 'rtc-offer', to: 'B', sdp: 'x'.repeat(LIMITS.sdpLength + 1) })).toBeNull();
    expect(parseClientMsg({ t: 'rtc-ice', to: 'B', candidate: cand })).toEqual({ t: 'rtc-ice', to: 'B', candidate: cand });
    // 省略されたフィールドは null にそろえる
    expect(parseClientMsg({ t: 'rtc-ice', to: 'B', candidate: { candidate: 'c', sdpMid: '0' } })).toMatchObject({
      candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: null, usernameFragment: null },
    });
    expect(parseClientMsg({ t: 'rtc-ice', to: 'B', candidate: { candidate: 'c' } })).toBeNull(); // m 行が分からない
    expect(parseClientMsg({ t: 'rtc-ice', to: 'B', candidate: { ...cand, sdpMLineIndex: -1 } })).toBeNull();
    expect(parseClientMsg({ t: 'rtc-ice', to: 'B', candidate: { ...cand, candidate: 'x'.repeat(LIMITS.iceLength + 1) } })).toBeNull();
    // hello の voice は省略可 (off)、不正なら拒否
    const h = { t: 'hello', v: PROTOCOL_VERSION, room: 'r', name: 'x', color: '#000000', device: 'desktop', space: '' };
    expect(parseClientMsg(h)).toMatchObject({ voice: 'off' });
    expect(parseClientMsg({ ...h, voice: 'muted' })).toMatchObject({ voice: 'muted' });
    expect(parseClientMsg({ ...h, voice: 'yes' })).toBeNull();
  });

  it('クォータニオンを正規化する', () => {
    const m = parseClientMsg({ t: 'move', id: 'cube', pose: { p: [0, 0, 0], q: [0, 0, 0, 0.9] } });
    expect(m).toMatchObject({ pose: { q: [0, 0, 0, 1] } });
  });
});
