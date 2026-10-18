// 少人数向けの WebRTC P2P メッシュ。音声に参加している相手ごとに RTCPeerConnection を 1 本張る。
// シグナリングは同期用の WebSocket に相乗りし (rtc-offer / rtc-answer / rtc-ice)、サーバーは宛先へ中継するだけ。
//
// 決まりごと (ネイティブクライアントも同じ規則に従えば相互に話せる):
//   - 接続するのは「自分も相手も voice !== 'off'」のピアとだけ。
//   - offer を出すのは id が小さい (文字列比較) 側。両側から同時に offer して衝突 (glare) することがない。
//   - 再交渉はしない。offer 側が最初から sendrecv の音声トランシーバを 1 本だけ作り、
//     マイクの付け外しは replaceTrack、ミュートは track.enabled で行うので SDP は変わらない。
//   - 張り直すときは RTCPeerConnection ごと作り直す。新しい offer が届いたら、その相手との古い接続は捨てる。
//   - 失敗やタイムアウトからの復帰は offer 側が担当する (間隔を空けて offer し直す)。

import type { ClientMsg, PeerInfo, RtcIceCandidate, ServerMsg } from '../../shared/protocol.ts';

export type RtcSignal = Extract<ServerMsg, { t: 'rtc-offer' | 'rtc-answer' | 'rtc-ice' }>;
export type LinkState = 'connecting' | 'connected' | 'failed';

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** つながるまで待つ時間。過ぎたら offer 側が張り直す。 */
const CONNECT_TIMEOUT_MS = 20000;
/** disconnected は一時的な瞬断のことが多いので、これだけ待ってから失敗扱いにする。 */
const DISCONNECTED_GRACE_MS = 5000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

export interface VoiceMeshDeps {
  send(msg: ClientMsg): void;
  /** 相手の音声ストリームが届いた / 無くなった (null)。 */
  onRemoteStream(peerId: string, stream: MediaStream | null): void;
  /** 接続の増減・状態の変化 (表示の更新用)。 */
  onLinkChange?(): void;
  iceServers?: RTCIceServer[];
  /** テストで差し替える。 */
  createPeerConnection?(config: RTCConfiguration): RTCPeerConnection;
}

class Link {
  readonly peerId: string;
  readonly pc: RTCPeerConnection;
  readonly offerer: boolean;
  state: LinkState = 'connecting';
  /** SDP / ICE の操作は非同期なので、1 本の接続につき順番に実行する。 */
  queue: Promise<void> = Promise.resolve();
  /** リモートの SDP より先に届いた ICE 候補。 */
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
  /** 音声に参加している他の参加者。 */
  private readonly voicePeers = new Set<string>();
  /** offer し直すまでの待ち (相手ごと)。 */
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

  /** 自分が通話に参加しているか。false にすると全部の接続を閉じる。 */
  setActive(active: boolean): void {
    this.active = active;
    this.reconcile();
  }

  /** 送るマイク音声。null なら聞くだけ。張ってある接続にもその場で反映する (再交渉なし)。 */
  setLocalTrack(track: MediaStreamTrack | null): void {
    this.track = track;
    for (const link of this.links.values()) {
      const tr = audioTransceiver(link.pc);
      if (tr && tr.sender.track !== track) tr.sender.replaceTrack(track).catch(() => {});
    }
  }

  /** サーバーから届いた最新の参加者一覧と自分の id に、張っている接続をそろえる。 */
  sync(selfId: string | null, peers: Iterable<PeerInfo>): void {
    this.selfId = selfId;
    this.voicePeers.clear();
    for (const p of peers) if (p.id !== selfId && p.voice !== 'off') this.voicePeers.add(p.id);
    this.reconcile();
  }

  /**
   * WebSocket が切れたとき。再接続すると自分の id が変わり、相手も古い id との接続を捨てるので、
   * こちらも全部閉じて、次の welcome で張り直す。
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

  /** デバッグ表示用。 */
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
    // 規則では offer を出すのは id の小さい側。参加していないはずの相手からの offer も受けない。
    if (this.isOfferer(from) || !this.voicePeers.has(from)) return;
    this.close(from);
    const link = this.open(from, false);
    this.enqueue(link, async () => {
      await link.pc.setRemoteDescription({ type: 'offer', sdp });
      // offer で作られたトランシーバは recvonly なので、送れるようにしてからマイクを載せる
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
      // 張り直しは offer 側に任せる。新しい offer が届けば作り直される。
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
      if (this.links.get(link.peerId) !== link) return; // 閉じた接続の後始末は不要
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
    // 作り直す前の接続宛ての古い候補などは捨ててよい
  }
}
