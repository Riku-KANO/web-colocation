// Checks the VoiceMesh (P2P mesh setup) rules with a fake RTCPeerConnection and a relay standing in for the server.

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
    // Like the real thing, ICE candidates appear after SLD
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
  /** Test helper: change the connection state. */
  set(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

/** Stands in for the server (Room): delivers rtc-* to the target VoiceMesh asynchronously. */
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

  /** The most recently created connection that is still open. */
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
  it('only the smaller id offers; answer and ICE are exchanged and audio flows both ways', async () => {
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
    // The answerer switches its recvonly transceiver to sendrecv and attaches the mic
    expect(b.pc!.transceivers[0].direction).toBe('sendrecv');
    expect(b.pc!.transceivers[0].sender.track).toBe(b.track);
    expect(a.pc!.transceivers[0].sender.track).toBe(a.track);
    expect(a.streams.has('b')).toBe(true);
    expect(b.streams.has('a')).toBe(true);

    a.pc!.set('connected');
    b.pc!.set('connected');
    expect(a.mesh.linkState('b')).toBe('connected');

    // Attaching/detaching the mic only swaps the sender track, no renegotiation
    a.mesh.setLocalTrack(null);
    await flush();
    expect(a.pc!.transceivers[0].sender.track).toBeNull();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1);
  });

  it('closes the link when the peer turns voice off or leaves, and reconnects when it returns', async () => {
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
    // b drops its old connection when the new offer arrives
    expect(b.pcs).toHaveLength(2);
    expect(b.pcs[0].closed).toBe(true);
    expect(b.pc).toBe(b.pcs[1]);

    a.mesh.sync('a', [peer('a', 'on')]); // peer-leave
    expect(a.pc).toBeUndefined();
  });

  it('does not connect or answer incoming offers while not in voice', async () => {
    const net = new Net();
    const a = new Node(net, 'a');
    const b = new Node(net, 'b');
    a.mesh.setActive(true);
    a.mesh.sync('a', [peer('a', 'on'), peer('b', 'on')]); // b is listed as in voice, but the real b has not joined
    b.mesh.sync('b', [peer('a', 'on'), peer('b', 'on')]);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1);
    expect(b.pcs).toHaveLength(0);
    expect(net.sent('b', 'rtc-answer')).toHaveLength(0);

    // a leaving closes everything
    a.mesh.setActive(false);
    expect(a.pc).toBeUndefined();
  });

  it('ignores an offer from the larger id, which breaks the rules', async () => {
    const { net, a } = pair();
    await flush();
    a.mesh.handleSignal({ t: 'rtc-offer', from: 'b', sdp: 'offer-x' });
    await flush();
    expect(a.pcs).toHaveLength(1);
    expect(net.sent('a', 'rtc-answer')).toHaveLength(0);
  });

  it('reconnecting (new id) rebuilds every link and re-picks the offerer by id', async () => {
    const { net, a, b } = pair();
    await flush();
    a.mesh.disconnect(); // WebSocket dropped
    expect(a.pcs.every((p) => p.closed)).toBe(true);
    expect(a.streams.size).toBe(0);

    // a rejoins as 'c'. 'b' < 'c', so this time b offers
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

  it('on failure the offerer retries with backoff while the answerer waits for a new offer', async () => {
    const { net, a, b } = pair();
    await flush();
    b.pc!.set('failed');
    expect(b.mesh.linkState('a')).toBe('failed');
    expect(b.pcs[0].closed).toBe(false); // the answerer does not close it on its own

    a.pc!.set('failed');
    expect(a.pcs[0].closed).toBe(true);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(1); // no immediate retry
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(2);
    expect(b.pcs[0].closed).toBe(true);
    expect(b.mesh.linkState('a')).toBe('connecting');

    // Also retries after timing out without connecting (2nd attempt, so after 2 s)
    await vi.advanceTimersByTimeAsync(20000);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(net.sent('a', 'rtc-offer')).toHaveLength(3);
  });
});
