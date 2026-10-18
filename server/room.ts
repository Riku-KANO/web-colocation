// 1 つのミーティングルームの状態と、その状態を変える唯一の場所。
// 通信手段 (ws / Durable Objects / テスト用の偽接続) には依存しない。

import {
  PROTOCOL_VERSION,
  defaultObjects,
  type AvatarPose,
  type ClientMsg,
  type ObjectState,
  type PeerInfo,
  type RoomSnapshot,
  type ServerMsg,
  type Stroke,
} from '../shared/protocol.ts';
import { LIMITS } from '../shared/validate.ts';

export interface PeerConn {
  /** シリアライズ済みの JSON を 1 メッセージとして送る。 */
  send(data: string): void;
}

type Hello = Extract<ClientMsg, { t: 'hello' }>;

interface PeerEntry {
  info: PeerInfo;
  conn: PeerConn;
  pose: AvatarPose | null;
}

export class Room {
  readonly id: string;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly objects = new Map<string, ObjectState>();
  /** 挿入順 = 描画順。 */
  private readonly strokes = new Map<string, Stroke>();

  constructor(id: string) {
    this.id = id;
    for (const o of defaultObjects()) this.objects.set(o.id, o);
  }

  get peerCount(): number {
    return this.peers.size;
  }

  join(peerId: string, conn: PeerConn, hello: Hello): PeerInfo {
    const info: PeerInfo = {
      id: peerId,
      name: hello.name.trim() || `Guest-${peerId.slice(0, 4)}`,
      color: hello.color,
      seat: this.freeSeat(),
      device: hello.device,
      space: hello.space,
      voice: hello.voice ?? 'off',
    };
    this.peers.set(peerId, { info, conn, pose: null });
    this.sendTo(peerId, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      room: this.id,
      self: info,
      snapshot: this.snapshot(),
    });
    this.broadcast({ t: 'peer-join', peer: info }, peerId);
    return info;
  }

  leave(peerId: string): void {
    if (!this.peers.delete(peerId)) return;
    // 掴んだまま切断されたオブジェクトは、最後の姿勢のまま手放す。
    for (const o of this.objects.values()) {
      if (o.owner === peerId) {
        o.owner = null;
        this.broadcast({ t: 'owner', id: o.id, owner: null, pose: o.pose });
      }
    }
    for (const s of this.strokes.values()) {
      if (s.author === peerId && !s.done) {
        s.done = true;
        this.broadcast({ t: 'stroke-end', id: s.id });
      }
    }
    this.broadcast({ t: 'peer-leave', id: peerId });
  }

  handle(peerId: string, msg: ClientMsg): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    switch (msg.t) {
      case 'hello':
        return; // 参加後の hello は無視
      case 'profile': {
        peer.info.device = msg.device;
        peer.info.space = msg.space;
        this.broadcast({ t: 'peer-update', peer: peer.info });
        return;
      }
      case 'voice': {
        if (peer.info.voice === msg.state) return;
        peer.info.voice = msg.state;
        this.broadcast({ t: 'peer-update', peer: peer.info });
        return;
      }
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice': {
        // 中身は解釈せず宛先へ中継するだけ。IP アドレス入りの ICE 候補を音声に参加していない人へ渡さないよう、
        // 送り主と宛先の両方が参加しているときに限る。
        const to = this.peers.get(msg.to);
        if (!to || msg.to === peerId || peer.info.voice === 'off' || to.info.voice === 'off') return;
        this.sendTo(
          msg.to,
          msg.t === 'rtc-ice'
            ? { t: 'rtc-ice', from: peerId, candidate: msg.candidate }
            : { t: msg.t, from: peerId, sdp: msg.sdp },
        );
        return;
      }
      case 'pose':
        peer.pose = msg.pose;
        this.broadcast({ t: 'pose', id: peerId, pose: msg.pose }, peerId);
        return;
      case 'grab': {
        const o = this.objects.get(msg.id);
        if (!o) return;
        if (o.owner !== null && o.owner !== peerId && this.peers.has(o.owner)) {
          this.sendTo(peerId, { t: 'grab-denied', id: o.id, owner: o.owner, pose: o.pose });
          return;
        }
        o.owner = peerId;
        this.broadcast({ t: 'owner', id: o.id, owner: peerId });
        return;
      }
      case 'move': {
        const o = this.objects.get(msg.id);
        if (!o || o.owner !== peerId) return; // 所有者以外の move は捨てる
        o.pose = msg.pose;
        this.broadcast({ t: 'move', id: o.id, pose: o.pose }, peerId);
        return;
      }
      case 'release': {
        const o = this.objects.get(msg.id);
        if (!o || o.owner !== peerId) return;
        o.pose = msg.pose;
        o.owner = null;
        this.broadcast({ t: 'owner', id: o.id, owner: null, pose: o.pose });
        return;
      }
      case 'stroke': {
        if (this.strokes.has(msg.id)) return;
        if (this.strokes.size >= LIMITS.strokesPerRoom) {
          this.sendTo(peerId, { t: 'error', message: 'ストローク数の上限に達しました。ボードを消去してください。' });
          return;
        }
        const s: Stroke = {
          id: msg.id,
          board: msg.board,
          author: peerId,
          color: msg.color,
          width: msg.width,
          pts: msg.pts.slice(0, LIMITS.ptsPerStroke),
          done: false,
        };
        this.strokes.set(s.id, s);
        this.broadcast({ t: 'stroke', stroke: s }, peerId);
        return;
      }
      case 'stroke-pts': {
        const s = this.strokes.get(msg.id);
        if (!s || s.author !== peerId || s.done) return;
        const room = LIMITS.ptsPerStroke - s.pts.length;
        if (room <= 0) return;
        const pts = msg.pts.length > room ? msg.pts.slice(0, room - (room % 2)) : msg.pts;
        s.pts.push(...pts);
        this.broadcast({ t: 'stroke-pts', id: s.id, pts }, peerId);
        return;
      }
      case 'stroke-end': {
        const s = this.strokes.get(msg.id);
        if (!s || s.author !== peerId || s.done) return;
        s.done = true;
        this.broadcast({ t: 'stroke-end', id: s.id }, peerId);
        return;
      }
      case 'board-clear': {
        for (const [id, s] of this.strokes) if (s.board === msg.board) this.strokes.delete(id);
        this.broadcast({ t: 'board-clear', board: msg.board }, peerId);
        return;
      }
      case 'reset-objects': {
        for (const d of defaultObjects()) {
          const o = this.objects.get(d.id);
          if (o && o.owner !== null && this.peers.has(o.owner)) continue; // 誰かが掴んでいる物はそのまま
          this.objects.set(d.id, d);
        }
        this.broadcast({ t: 'objects', objects: [...this.objects.values()] });
        return;
      }
      case 'ping':
        this.sendTo(peerId, { t: 'pong', ts: msg.ts });
        return;
    }
  }

  snapshot(): RoomSnapshot {
    const poses: Record<string, AvatarPose> = {};
    for (const [id, p] of this.peers) if (p.pose) poses[id] = p.pose;
    return {
      peers: [...this.peers.values()].map((p) => p.info),
      poses,
      objects: [...this.objects.values()],
      strokes: [...this.strokes.values()],
    };
  }

  private freeSeat(): number {
    const used = new Set([...this.peers.values()].map((p) => p.info.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    return seat;
  }

  private sendTo(peerId: string, msg: ServerMsg): void {
    this.peers.get(peerId)?.conn.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg, exceptPeerId?: string): void {
    const data = JSON.stringify(msg);
    for (const [id, p] of this.peers) if (id !== exceptPeerId) p.conn.send(data);
  }
}
