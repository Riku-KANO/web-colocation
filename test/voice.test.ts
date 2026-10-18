// VoiceMesh (P2P メッシュの張り方) の規則を、偽の RTCPeerConnection とサーバー代わりの中継で確かめる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMsg, PeerInfo, RtcIceCandidate, VoiceState } from '../shared/protocol.ts';
import { VoiceMesh } from '../src/voice/mesh.ts';

type Handler<E> = ((e: E) => void) | null;

class FakeSender {
  track: MediaStreamTrack | null;
  constructor(track: MediaStreamTrack | null) {
    this.track = track;
  }
  async replaceTrack(t: MediaStreamTrack | null) {
    this.track = t;
  }
}

class FakeTransceiver {
  direction: RTCRtpTransceiverDirection;
  readonly sender: FakeSender;
  readonly receiver = { track: { kind: 'audio' } };
  constructor(direction: RTCRtpTransceiverDirection, track: MediaStreamTrack | null) {
    this.direction = direction;
    this.sender = new FakeSender(track);
  }
}

let pcSeq = 0;

class FakePC {
  readonly n = ++pcSeq;
  onicecandidate: Handler<{ candidate: { candidate: string; toJSON(): RTCIceCandidateInit } | null }> = null;
  ontrack: Handler<{ streams: unknown[]; track: unknown }> = null;
  onconnectionstatechange: Handler<void> = null;
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  readonly transceivers: FakeTransceiver[] = [];
  readonly addedIce: RtcIceCandidate[] = [];
  readonly stream = { id: `stream-${this.n}` };

  addTransceiver(trackOrKind: MediaStreamTrack | string, init: RTCRtpTransceiverInit) {
    const t = new FakeTransceiver(init.direction ?? 'sendrecv', typeof trackOrKind === 'string' ? null : trackOrKind);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: `offer-${this.n}` };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: `answer-${this.n}` };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    // 本物と同じく、SLD の後に ICE 候補が出てくる
    setTimeout(() =>
      this.onicecandidate?.({
        candidate: {
          candidate: `candidate:${this.n}`,
          toJSON: () => ({ candidate: `candidate:${this.n}`, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' }),
        },
      }),
    );
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d;
    if (d.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      if (this.transceivers.length === 0) this.addTransceiver('audio', { direction: 'recvonly' });
    } else {
      this.signalingState = 'stable';
    }
    this.ontrack?.({ streams: [this.stream], track: {} });
  }
  async addIceCandidate(c: RtcIceCandidate) {
    if (!this.remoteDescription) throw new Error('remote description is not set');
    this.addedIce.push(c);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  /** テスト用: 接続状態を変える。 */
  set(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

/** サーバー (Room) の代わりに rtc-* を宛先の VoiceMesh へ非同期で届ける。 */
class Net {
  readonly nodes = new Map<string, Node>();
  readonly log: Array<{ from: string; msg: ClientMsg }> = [];

  route(from: string, msg: ClientMsg) {
    this.log.push({ from, msg });
    if (msg.t !== 'rtc-offer' && msg.t !== 'rtc-answer' && msg.t !== 'rtc-ice') return;
    const to = this.nodes.get(msg.to);
    setTimeout(() => {
      if (!to) return;
      if (msg.t === 'rtc-ice') to.mesh.handleSignal({ t: 'rtc-ice', from, candidate: msg.candidate });
      else to.mesh.handleSignal({ t: msg.t, from, sdp: msg.sdp });
    });
  }

  sent(from: string, t: ClientMsg['t']) {
    return this.log.filter((l) => l.from === from && l.msg.t === t).map((l) => l.msg);
  }
}

class Node {
  id: string;
  readonly mesh: VoiceMesh;
  readonly pcs: FakePC[] = [];
  readonly streams = new Map<string, unknown>();
  readonly track = { kind: 'audio', id: 'mic' } as unknown as MediaStreamTrack;

  constructor(net: Net, id: string) {
    this.id = id;
    net.nodes.set(id, this);
    this.mesh = new VoiceMesh({
      send: (m) => net.route(this.id, m),
      onRemoteStream: (peer, s) => (s ? this.streams.set(peer, s) : this.streams.delete(peer)),
      createPeerConnection: () => {
        const pc = new FakePC();
        this.pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
  }

  /** 最後に作った、まだ閉じていない接続。 */
  get pc(): FakePC | undefined {
    return this.pcs.filter((p) => !p.closed).at(-1);
  }
}

const peer = (id: string, voice: VoiceState): PeerInfo => ({
  id,
  name: id,
  color: '#000000',
  seat: 0,
  device: 'desktop',
  space: '',
  voice,
  role: 'member',
  verified: false,
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function pair() {
  const net = new Net();
  const a = new Node(net, 'a');
  const b = new Node(net, 'b');
  const peers = [peer('a', 'on'), peer('b', 'on')];
  a.mesh.setLocalTrack(a.track);
  b.mesh.setLocalTrack(b.track);
  a.mesh.setActive(true);
  b.mesh.setActive(true);
  a.mesh.sync('a', peers);
  b.mesh.sync('b', peers);
  return { net, a, b };
}

describe('VoiceMesh', () => {
  it('id の小さい側だけが offer し、answer と ICE を交換して双方に音声が届く', async () => {
    const { net, a, b } = pair();
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1);
    expect(net.sent('b', 'rtc-offer')).toHaveLength(0);
    expect(net.sent('b', 'rtc-answer')).toHaveLength(1);
    expect(a.pcs).toHaveLength(1);
    expect(b.pcs).toHaveLength(1);
    expect(a.pc!.remoteDescription).toMatchObject({ type: 'answer' });
    expect(a.pc!.addedIce).toHaveLength(1);
    expect(b.pc!.addedIce).toHaveLength(1);
    // answer 側は recvonly で作られたトランシーバを sendrecv にしてマイクを載せる
    expect(b.pc!.transceivers[0].direction).toBe('sendrecv');
    expect(b.pc!.transceivers[0].sender.track).toBe(b.track);
    expect(a.pc!.transceivers[0].sender.track).toBe(a.track);
    expect(a.streams.has('b')).toBe(true);
    expect(b.streams.has('a')).toBe(true);

    a.pc!.set('connected');
    b.pc!.set('connected');
    expect(a.mesh.linkState('b')).toBe('connected');

    // マイクの付け外しは再交渉せず送信トラックの差し替えだけ
    a.mesh.setLocalTrack(null);
    await flush();
    expect(a.pc!.transceivers[0].sender.track).toBeNull();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1);
  });

  it('相手が音声を切ったり退出したら接続を閉じ、戻ってきたら張り直す', async () => {
    const { net, a, b } = pair();
    await flush();
    const first = a.pc!;
    a.mesh.sync('a', [peer('a', 'on'), peer('b', 'off')]);
    expect(first.closed).toBe(true);
    expect(a.streams.has('b')).toBe(false);
    expect(a.mesh.linkState('b')).toBeNull();

    a.mesh.sync('a', [peer('a', 'on'), peer('b', 'muted')]);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(2);
    // b は新しい offer を受けて古い接続を捨てる
    expect(b.pcs).toHaveLength(2);
    expect(b.pcs[0].closed).toBe(true);
    expect(b.pc).toBe(b.pcs[1]);

    a.mesh.sync('a', [peer('a', 'on')]); // peer-leave
    expect(a.pc).toBeUndefined();
  });

  it('自分が参加していなければ接続を張らず、届いた offer にも応じない', async () => {
    const net = new Net();
    const a = new Node(net, 'a');
    const b = new Node(net, 'b');
    a.mesh.setActive(true);
    a.mesh.sync('a', [peer('a', 'on'), peer('b', 'on')]); // b は参加中という情報だが、実際の b は未参加
    b.mesh.sync('b', [peer('a', 'on'), peer('b', 'on')]);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1);
    expect(b.pcs).toHaveLength(0);
    expect(net.sent('b', 'rtc-answer')).toHaveLength(0);

    // a が退出すると全部閉じる
    a.mesh.setActive(false);
    expect(a.pc).toBeUndefined();
  });

  it('規則に反して id の大きい側から来た offer は受けない', async () => {
    const { net, a } = pair();
    await flush();
    a.mesh.handleSignal({ t: 'rtc-offer', from: 'b', sdp: 'offer-x' });
    await flush();
    expect(a.pcs).toHaveLength(1);
    expect(net.sent('a', 'rtc-answer')).toHaveLength(0);
  });

  it('再接続 (新しい id) で接続を全部作り直し、offer 側も id で決め直す', async () => {
    const { net, a, b } = pair();
    await flush();
    a.mesh.disconnect(); // WebSocket が切れた
    expect(a.pcs.every((p) => p.closed)).toBe(true);
    expect(a.streams.size).toBe(0);

    // a は新しい id 'c' で入り直す。'b' < 'c' なので今度は b が offer する
    net.nodes.delete('a');
    a.id = 'c';
    net.nodes.set('c', a);
    const peers = [peer('b', 'on'), peer('c', 'on')];
    b.mesh.sync('b', peers); // peer-leave(a) + peer-join(c)
    a.mesh.sync('c', peers); // welcome
    await flush();
    expect(b.pcs[0].closed).toBe(true);
    expect(net.sent('b', 'rtc-offer')).toHaveLength(1);
    expect(net.sent('c', 'rtc-answer')).toHaveLength(1);
    expect(a.streams.has('b')).toBe(true);
    expect(b.streams.has('c')).toBe(true);
  });

  it('失敗したら offer 側が間隔を空けて張り直し、answer 側は新しい offer を待つ', async () => {
    const { net, a, b } = pair();
    await flush();
    b.pc!.set('failed');
    expect(b.mesh.linkState('a')).toBe('failed');
    expect(b.pcs[0].closed).toBe(false); // answer 側は自分からは閉じない

    a.pc!.set('failed');
    expect(a.pcs[0].closed).toBe(true);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1); // すぐには張り直さない
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(2);
    expect(b.pcs[0].closed).toBe(true);
    expect(b.mesh.linkState('a')).toBe('connecting');

    // つながらないままタイムアウトしても張り直す (2 回目なので 2 秒後)
    await vi.advanceTimersByTimeAsync(20000);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(3);
  });
});
