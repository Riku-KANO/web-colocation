// State of one meeting room and the only place that mutates it.
// Transport-agnostic (ws, tests, or a future Durable Object): peers are just `PeerConn`s.

import {
  CLOSE_FATAL,
  PROTOCOL_VERSION,
  type AvatarPose,
  type ClientMsg,
  type ErrorCode,
  type ObjectState,
  type PeerInfo,
  type Role,
  type RoomSnapshot,
  type ServerMsg,
  type Stroke,
} from '../shared/protocol.ts';
import type { PermissionLevel, RoomConfig, RoomSettingsPatch } from '../shared/roomConfig.ts';
import { LIMITS } from '../shared/validate.ts';
import type { Identity } from './auth.ts';

export interface PeerConn {
  /** Send one serialized JSON message. */
  send(data: string): void;
  /** Close the connection (used when a participant is removed). */
  close?(code: number, reason: string): void;
}

type Hello = Extract<ClientMsg, { t: 'hello' }>;

export interface JoinRequest {
  hello: Hello;
  /** Display name (already taken from the SSO identity when applicable). */
  name: string;
  verified: boolean;
  /** The identity is listed in the room's hosts or is a global admin. */
  configuredHost: boolean;
  /** SSO identity (trusted-headers auth), kept to re-check access when the config changes. */
  identity?: Identity | null;
}

export interface RoomHooks {
  /** State changed in a way worth persisting (objects settled, strokes, settings). */
  onChange?(): void;
  /**
   * A host asked to change the room settings (permission already checked). The owner validates
   * and persists it (possibly asynchronously), then calls `reconfigure()` or `notify()`s an error.
   */
  applySettings?(peerId: string, patch: RoomSettingsPatch): void;
}

export interface RoomOptions {
  /**
   * 'configured': only people listed as hosts (or admins) are hosts.
   * 'first-joiner': the earliest participant still present is the host (ad-hoc rooms).
   */
  hostMode: 'configured' | 'first-joiner';
  hooks?: RoomHooks;
}

interface PeerEntry {
  info: PeerInfo;
  conn: PeerConn;
  pose: AvatarPose | null;
  configuredHost: boolean;
  identity: Identity | null;
}

type Action = 'clearBoard' | 'resetObjects' | 'editSettings';

const clone = <T>(v: T): T => structuredClone(v);

export class Room {
  readonly id: string;
  config: RoomConfig;
  /** Increases when the room is reconfigured; stale client messages are dropped. */
  epoch = 1;
  hostMode: RoomOptions['hostMode'];
  private readonly hooks: RoomHooks;
  private readonly peers = new Map<string, PeerEntry>();
  private objects = new Map<string, ObjectState>();
  /** Insertion order = drawing order. */
  private readonly strokes = new Map<string, Stroke>();
  private strokePoints = 0;

  constructor(config: RoomConfig, options: RoomOptions = { hostMode: 'first-joiner' }) {
    this.id = config.id;
    this.config = config;
    this.hostMode = options.hostMode;
    this.hooks = options.hooks ?? {};
    this.resetObjectsFromConfig();
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** People that fit: limited by the rules and by the number of seats. */
  get capacity(): number {
    return Math.min(this.config.rules.maxParticipants, this.config.seats.length);
  }

  /** Why a new participant cannot join right now, or null. */
  admissionError(): ErrorCode | null {
    return this.peers.size >= this.capacity ? 'room-full' : null;
  }

  join(peerId: string, conn: PeerConn, req: JoinRequest): PeerInfo {
    const { hello } = req;
    const info: PeerInfo = {
      id: peerId,
      name: req.name.trim() || `Guest-${peerId.slice(0, 4)}`,
      color: hello.color,
      seat: this.freeSeat(),
      device: hello.device,
      space: hello.space,
      voice: hello.voice ?? 'off',
      role: this.initialRole(req.configuredHost),
      verified: req.verified,
    };
    this.peers.set(peerId, { info, conn, pose: null, configuredHost: req.configuredHost, identity: req.identity ?? null });
    this.sendTo(peerId, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      room: this.id,
      self: info,
      epoch: this.epoch,
      config: this.config,
      snapshot: this.snapshot(),
    });
    this.broadcast({ t: 'peer-join', peer: info }, peerId);
    return info;
  }

  leave(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    // Objects held by someone who disconnects are released where they are.
    let changed = false;
    for (const o of this.objects.values()) {
      if (o.owner === peerId) {
        o.owner = null;
        changed = true;
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
    if (entry.info.role === 'host') this.promoteHost();
    if (changed) this.hooks.onChange?.();
  }

  /** Send a message to one participant (used by the server for `ice` updates). */
  notify(peerId: string, msg: ServerMsg): void {
    this.sendTo(peerId, msg);
  }

  has(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  /** Participants with their identities (for re-checking access after a config reload). */
  members(): Array<{ id: string; identity: Identity | null }> {
    return [...this.peers.values()].map((p) => ({ id: p.info.id, identity: p.identity }));
  }

  /** Remove a participant with an error (e.g. access revoked); their client will not reconnect. */
  kick(peerId: string, code: ErrorCode): void {
    const p = this.peers.get(peerId);
    if (!p) return;
    this.sendTo(peerId, { t: 'error', code });
    p.conn.close?.(CLOSE_FATAL, code);
    this.leave(peerId);
  }

  /**
   * Re-evaluate host roles (config reload changed `hosts` / `admins`). `isConfiguredHost` gets
   * each participant's identity.
   */
  refreshRoles(hostMode: RoomOptions['hostMode'], isConfiguredHost: (identity: Identity | null) => boolean): void {
    this.hostMode = hostMode;
    const changed: PeerEntry[] = [];
    for (const p of this.peers.values()) {
      p.configuredHost = isConfiguredHost(p.identity);
      const role: Role = p.configuredHost ? 'host' : hostMode === 'first-joiner' && p.info.role === 'host' ? 'host' : 'member';
      if (role !== p.info.role) {
        p.info.role = role;
        changed.push(p);
      }
    }
    for (const p of changed) this.broadcast({ t: 'peer-update', peer: p.info });
    this.promoteHost();
  }

  handle(peerId: string, msg: ClientMsg): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    // Messages produced before the latest reconfiguration refer to objects/boards that may be gone.
    if ('e' in msg && msg.e !== this.epoch) return;
    switch (msg.t) {
      case 'hello':
        return;
      case 'profile':
        peer.info.device = msg.device;
        peer.info.space = msg.space;
        this.broadcast({ t: 'peer-update', peer: peer.info });
        return;
      case 'voice':
        if (peer.info.voice === msg.state) return;
        peer.info.voice = msg.state;
        this.broadcast({ t: 'peer-update', peer: peer.info });
        return;
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice': {
        // Relay only between peers that both joined voice, so ICE candidates (IP addresses)
        // never reach people who are not in the call.
        const to = this.peers.get(msg.to);
        if (!this.config.rules.voice.enabled) return;
        if (!to || msg.to === peerId || peer.info.voice === 'off' || to.info.voice === 'off') return;
        this.sendTo(
          msg.to,
          msg.t === 'rtc-ice' ? { t: 'rtc-ice', from: peerId, candidate: msg.candidate } : { t: msg.t, from: peerId, sdp: msg.sdp },
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
        if (!o || o.owner !== peerId) return; // only the owner may move it
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
        this.hooks.onChange?.();
        return;
      }
      case 'stroke': {
        if (this.strokes.has(msg.id) || !this.config.boards.some((b) => b.id === msg.board)) return;
        if (this.strokes.size >= LIMITS.strokesPerRoom || this.strokePoints >= LIMITS.ptsPerRoom) {
          this.sendTo(peerId, { t: 'error', code: 'limit', message: 'whiteboard is full' });
          return;
        }
        const pts = msg.pts.slice(0, LIMITS.ptsPerStroke);
        const s: Stroke = { id: msg.id, board: msg.board, author: peerId, color: msg.color, width: msg.width, pts, done: false };
        this.strokes.set(s.id, s);
        this.strokePoints += pts.length;
        this.broadcast({ t: 'stroke', stroke: s }, peerId);
        return;
      }
      case 'stroke-pts': {
        const s = this.strokes.get(msg.id);
        if (!s || s.author !== peerId || s.done) return;
        const room = Math.min(LIMITS.ptsPerStroke - s.pts.length, LIMITS.ptsPerRoom - this.strokePoints);
        if (room <= 1) return;
        const pts = msg.pts.length > room ? msg.pts.slice(0, room - (room % 2)) : msg.pts;
        s.pts.push(...pts);
        this.strokePoints += pts.length;
        this.broadcast({ t: 'stroke-pts', id: s.id, pts }, peerId);
        return;
      }
      case 'stroke-end': {
        const s = this.strokes.get(msg.id);
        if (!s || s.author !== peerId || s.done) return;
        s.done = true;
        this.broadcast({ t: 'stroke-end', id: s.id }, peerId);
        this.hooks.onChange?.();
        return;
      }
      case 'board-clear': {
        if (!this.permitted(peer, 'clearBoard')) return;
        for (const [id, s] of this.strokes) {
          if (s.board === msg.board) {
            this.strokes.delete(id);
            this.strokePoints -= s.pts.length;
          }
        }
        this.broadcast({ t: 'board-clear', board: msg.board }, peerId);
        this.hooks.onChange?.();
        return;
      }
      case 'reset-objects': {
        if (!this.permitted(peer, 'resetObjects')) return;
        for (const spec of this.config.objects) {
          const o = this.objects.get(spec.id);
          if (o && o.owner !== null && this.peers.has(o.owner)) continue; // keep objects someone is holding
          this.objects.set(spec.id, { ...clone(spec), owner: null });
        }
        this.broadcast({ t: 'objects', objects: [...this.objects.values()] });
        this.hooks.onChange?.();
        return;
      }
      case 'room-settings': {
        if (!this.permitted(peer, 'editSettings')) return;
        if (this.hooks.applySettings) this.hooks.applySettings(peerId, msg.settings);
        else this.sendTo(peerId, { t: 'error', code: 'not-allowed' });
        return;
      }
      case 'ping':
        this.sendTo(peerId, { t: 'pong', ts: msg.ts });
        return;
    }
  }

  /**
   * Replace the room configuration atomically: release held objects, reset objects, drop strokes
   * on boards that no longer exist, keep seats where possible, bump the epoch and send every
   * participant the new config with a full snapshot.
   */
  reconfigure(config: RoomConfig): void {
    this.config = config;
    this.epoch++;
    this.resetObjectsFromConfig();
    const boards = new Set(config.boards.map((b) => b.id));
    for (const [id, s] of this.strokes) {
      if (!boards.has(s.board)) {
        this.strokes.delete(id);
        this.strokePoints -= s.pts.length;
      } else if (!s.done) s.done = true;
    }
    const taken = new Set<number>();
    const reseat: PeerEntry[] = [];
    for (const p of this.peers.values()) {
      if (p.info.seat < config.seats.length && !taken.has(p.info.seat)) taken.add(p.info.seat);
      else reseat.push(p);
    }
    for (const p of reseat) {
      let seat = 0;
      while (taken.has(seat)) seat++;
      p.info.seat = seat; // may exceed seats.length if the room shrank; clients wrap around
      taken.add(seat);
    }
    const snapshot = this.snapshot();
    for (const [id, p] of this.peers) {
      this.sendTo(id, { t: 'config', epoch: this.epoch, config: this.config, self: p.info, snapshot });
    }
    this.hooks.onChange?.();
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

  /** Persistable state (no peers): settled object poses and finished strokes. */
  exportState(): { objects: ObjectState[]; strokes: Stroke[] } {
    return {
      objects: [...this.objects.values()].map((o) => ({ ...clone(o), owner: null })),
      strokes: [...this.strokes.values()].filter((s) => s.done).map(clone),
    };
  }

  /** Restore persisted state; unknown objects/boards are ignored and nobody holds anything. */
  importState(state: { objects?: ObjectState[]; strokes?: Stroke[] }): void {
    for (const o of state.objects ?? []) {
      const cur = this.objects.get(o.id);
      if (cur) cur.pose = o.pose;
    }
    const boards = new Set(this.config.boards.map((b) => b.id));
    for (const s of state.strokes ?? []) {
      if (!boards.has(s.board) || this.strokes.has(s.id)) continue;
      if (this.strokePoints + s.pts.length > LIMITS.ptsPerRoom) break;
      this.strokes.set(s.id, { ...s, done: true });
      this.strokePoints += s.pts.length;
    }
  }

  private resetObjectsFromConfig(): void {
    this.objects = new Map(this.config.objects.map((o) => [o.id, { ...clone(o), owner: null }]));
  }

  private permitted(peer: PeerEntry, action: Action): boolean {
    const level: PermissionLevel = this.config.rules.permissions[action];
    if (level === 'everyone' || peer.info.role === 'host') return true;
    this.sendTo(peer.info.id, { t: 'error', code: 'not-allowed' });
    return false;
  }

  private initialRole(configuredHost: boolean): Role {
    if (configuredHost) return 'host';
    if (this.hostMode === 'first-joiner' && ![...this.peers.values()].some((p) => p.info.role === 'host')) return 'host';
    return 'member';
  }

  /** In ad-hoc rooms the earliest remaining participant becomes host when the host leaves. */
  private promoteHost(): void {
    if (this.hostMode !== 'first-joiner') return;
    if ([...this.peers.values()].some((p) => p.info.role === 'host')) return;
    const next = this.peers.values().next().value;
    if (!next) return;
    next.info.role = 'host';
    this.broadcast({ t: 'peer-update', peer: next.info });
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
