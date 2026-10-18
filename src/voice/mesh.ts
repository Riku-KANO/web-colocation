// WebRTC P2P mesh for small groups: one RTCPeerConnection per peer that is in voice.
// Signaling rides on the sync WebSocket (rtc-offer / rtc-answer / rtc-ice); the server only relays to the target.
//
// Rules (a native client that follows them can talk to us too):
//   - Connect only when both we and the peer have voice !== 'off'.
//   - The side with the smaller id (string comparison) offers, so both sides never offer at once (glare).
//   - No renegotiation. The offerer creates a single sendrecv audio transceiver up front;
//     the mic is swapped with replaceTrack and muted with track.enabled, so the SDP never changes.
//   - Reconnecting recreates the whole RTCPeerConnection. A new offer replaces any old link to that peer.
//   - The offerer recovers from failures and timeouts (re-offers with backoff).

import type { ClientMsg, PeerInfo, RtcIceCandidate, ServerMsg } from '../../shared/protocol.ts';

export type RtcSignal = Extract<ServerMsg, { t: 'rtc-offer' | 'rtc-answer' | 'rtc-ice' }>;
export type LinkState = 'connecting' | 'connected' | 'failed';

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** How long to wait for a connection before the offerer starts over. */
const CONNECT_TIMEOUT_MS = 20000;
/** 'disconnected' is often a brief blip, so wait this long before treating it as failed. */
const DISCONNECTED_GRACE_MS = 5000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

export interface VoiceMeshDeps {
  send(msg: ClientMsg): void;
  /** A peer's audio stream arrived or went away (null). */
  onRemoteStream(peerId: string, stream: MediaStream | null): void;
  /** Links were added, removed or changed state (to refresh the UI). */
  onLinkChange?(): void;
  iceServers?: RTCIceServer[];
  /** Replaced in tests. */
  createPeerConnection?(config: RTCConfiguration): RTCPeerConnection;
}

class Link {
  readonly peerId: string;
  readonly pc: RTCPeerConnection;
  readonly offerer: boolean;
  state: LinkState = 'connecting';
  /** SDP / ICE operations are async, so they run one at a time per link. */
  queue: Promise<void> = Promise.resolve();
  /** ICE candidates that arrived before the remote SDP. */
  readonly pendingIce: RtcIceCandidate[] = [];
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(peerId: string, pc: RTCPeerConnection, offerer: boolean) {
    this.peerId = peerId;
    this.pc = pc;
    this.offerer = offerer;
  }
}

export class VoiceMesh {
  private readonly deps: VoiceMeshDeps;
  private readonly links = new Map<string, Link>();
  /** Other participants who are in voice. */
  private readonly voicePeers = new Set<string>();
  /** Pending re-offer timers, per peer. */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private selfId: string | null = null;
  private active = false;
  private track: MediaStreamTrack | null = null;
  private iceServers: RTCIceServer[];

  constructor(deps: VoiceMeshDeps) {
    this.deps = deps;
    this.iceServers = deps.iceServers ?? DEFAULT_ICE_SERVERS;
  }

  /**
   * ICE servers from the server (`ice` message), including short-lived TURN credentials.
   * Existing connections get the new credentials for future ICE restarts.
   */
  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers;
    for (const link of this.links.values()) {
      try {
        link.pc.setConfiguration({ ...link.pc.getConfiguration(), iceServers: servers });
      } catch {
        // some browsers refuse changes they consider incompatible; new links still use them
      }
    }
  }

  /** Whether we are in the call. false closes every link. */
  setActive(active: boolean): void {
    this.active = active;
    this.reconcile();
  }

  /** Mic track to send; null means listen-only. Applied to existing links in place (no renegotiation). */
  setLocalTrack(track: MediaStreamTrack | null): void {
    this.track = track;
    for (const link of this.links.values()) {
      const tr = audioTransceiver(link.pc);
      if (tr && tr.sender.track !== track) tr.sender.replaceTrack(track).catch(() => {});
    }
  }

  /** Reconcile links with the latest participant list and our own id from the server. */
  sync(selfId: string | null, peers: Iterable<PeerInfo>): void {
    this.selfId = selfId;
    this.voicePeers.clear();
    for (const p of peers) if (p.id !== selfId && p.voice !== 'off') this.voicePeers.add(p.id);
    this.reconcile();
  }

  /**
   * The WebSocket dropped. Reconnecting gives us a new id and peers drop links to the old one,
   * so close everything as well and reconnect on the next welcome.
   */
  disconnect(): void {
    this.sync(null, []);
  }

  handleSignal(m: RtcSignal): void {
    if (!this.active || this.selfId === null) return;
    switch (m.t) {
      case 'rtc-offer':
        this.onOffer(m.from, m.sdp);
        return;
      case 'rtc-answer': {
        const link = this.links.get(m.from);
        if (!link?.offerer) return;
        this.enqueue(link, async () => {
          if (link.pc.signalingState !== 'have-local-offer') return;
          await link.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          await this.flushIce(link);
        });
        return;
      }
      case 'rtc-ice': {
        const link = this.links.get(m.from);
        if (!link) return;
        this.enqueue(link, async () => {
          if (link.pc.remoteDescription) await addIce(link.pc, m.candidate);
          else link.pendingIce.push(m.candidate);
        });
        return;
      }
    }
  }

  linkState(peerId: string): LinkState | null {
    return this.links.get(peerId)?.state ?? null;
  }

  /** For the debug overlay. */
  summary(): Array<{ peer: string; state: LinkState; offerer: boolean }> {
    return [...this.links.values()].map((l) => ({ peer: l.peerId, state: l.state, offerer: l.offerer }));
  }

  private isOfferer(peerId: string): boolean {
    return this.selfId !== null && this.selfId < peerId;
  }

  private reconcile(): void {
    const on = this.active && this.selfId !== null;
    const wanted = (id: string) => on && this.voicePeers.has(id);
    for (const id of [...this.links.keys()]) if (!wanted(id)) this.close(id);
    for (const [id, timer] of this.retryTimers) {
      if (wanted(id)) continue;
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
    for (const id of [...this.attempts.keys()]) if (!wanted(id)) this.attempts.delete(id);
    if (!on) return;
    for (const id of this.voicePeers) {
      if (!this.links.has(id) && !this.retryTimers.has(id) && this.isOfferer(id)) this.offer(id);
    }
  }

  private offer(peerId: string): void {
    const link = this.open(peerId, true);
    link.pc.addTransceiver(this.track ?? 'audio', { direction: 'sendrecv' });
    this.enqueue(link, async () => {
      const offer = await link.pc.createOffer();
      await link.pc.setLocalDescription(offer);
      this.deps.send({ t: 'rtc-offer', to: peerId, sdp: offer.sdp ?? '' });
    });
  }

  private onOffer(from: string, sdp: string): void {
    // Only the smaller id may offer. Also ignore offers from peers that should not be in voice.
    if (this.isOfferer(from) || !this.voicePeers.has(from)) return;
    this.close(from);
    const link = this.open(from, false);
    this.enqueue(link, async () => {
      await link.pc.setRemoteDescription({ type: 'offer', sdp });
      // The transceiver created by the offer is recvonly; make it sendrecv before attaching the mic
      const tr = audioTransceiver(link.pc);
      if (tr) {
        tr.direction = 'sendrecv';
        if (this.track) await tr.sender.replaceTrack(this.track);
      }
      await this.flushIce(link);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.deps.send({ t: 'rtc-answer', to: from, sdp: answer.sdp ?? '' });
    });
  }

  private open(peerId: string, offerer: boolean): Link {
    const config: RTCConfiguration = { iceServers: this.iceServers };
    const pc = this.deps.createPeerConnection?.(config) ?? new RTCPeerConnection(config);
    const link = new Link(peerId, pc, offerer);
    this.links.set(peerId, link);
    const current = () => this.links.get(peerId) === link;

    pc.onicecandidate = (e) => {
      if (!current() || !e.candidate?.candidate) return;
      const c = e.candidate.toJSON();
      this.deps.send({
        t: 'rtc-ice',
        to: peerId,
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };
    pc.ontrack = (e) => {
      if (current()) this.deps.onRemoteStream(peerId, e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (current()) this.onPcState(link);
    };
    link.timer = setTimeout(() => {
      if (link.state !== 'connected') this.fail(link);
    }, CONNECT_TIMEOUT_MS);
    this.deps.onLinkChange?.();
    return link;
  }

  private onPcState(link: Link): void {
    switch (link.pc.connectionState) {
      case 'connected':
        link.state = 'connected';
        clearTimeout(link.timer);
        this.attempts.delete(link.peerId);
        break;
      case 'disconnected':
        link.state = 'connecting';
        clearTimeout(link.timer);
        link.timer = setTimeout(() => {
          if (link.pc.connectionState !== 'connected') this.fail(link);
        }, DISCONNECTED_GRACE_MS);
        break;
      case 'failed':
        this.fail(link);
        return;
      default:
        return;
    }
    this.deps.onLinkChange?.();
  }

  private fail(link: Link): void {
    if (this.links.get(link.peerId) !== link) return;
    if (!link.offerer) {
      // Leave reconnecting to the offerer; a new offer will recreate the link.
      link.state = 'failed';
      this.deps.onLinkChange?.();
      return;
    }
    const id = link.peerId;
    this.close(id);
    const n = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, n);
    const delay = Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id);
        this.reconcile();
      }, delay),
    );
  }

  private close(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    clearTimeout(link.timer);
    link.pc.onicecandidate = null;
    link.pc.ontrack = null;
    link.pc.onconnectionstatechange = null;
    link.pc.close();
    this.deps.onRemoteStream(peerId, null);
    this.deps.onLinkChange?.();
  }

  private enqueue(link: Link, task: () => Promise<void>): void {
    link.queue = link.queue.then(async () => {
      if (this.links.get(link.peerId) !== link) return; // the link was closed; nothing to do
      try {
        await task();
      } catch (e) {
        console.warn('[voice] signaling failed', link.peerId, e);
        this.fail(link);
      }
    });
  }

  private async flushIce(link: Link): Promise<void> {
    for (const c of link.pendingIce.splice(0)) await addIce(link.pc, c);
  }
}

function audioTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
}

async function addIce(pc: RTCPeerConnection, c: RtcIceCandidate): Promise<void> {
  try {
    await pc.addIceCandidate(c);
  } catch {
    // safe to drop, e.g. stale candidates meant for a link that has since been recreated
  }
}
