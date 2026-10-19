// Room lifecycle: resolves room ids to configurations, enforces access (SSO allow lists,
// passcodes, capacity), creates/disposes Room instances and persists their state.

import type { ClientMsg, ErrorCode, PeerInfo } from '../shared/protocol.ts';
import type { ClientConfig, LobbyRoom } from '../shared/clientConfig.ts';
import type { RoomConfig, RoomSettingsPatch } from '../shared/roomConfig.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { cleanText, LIMITS } from '../shared/validate.ts';
import { isAdmin, isAllowed, type Identity } from './auth.ts';
import type { LoadedConfig } from './config/load.ts';
import { buildRoomConfig, mergeRules } from './config/resolve.ts';
import type { RoomDefinition } from './config/schema.ts';
import type { Logger } from './log.ts';
import type { Metrics } from './metrics.ts';
import { hashPasscode, verifyPasscode } from './passcode.ts';
import { FailureLimiter } from './rateLimit.ts';
import { PointBudget, Room, type PeerConn } from './room.ts';
import { MemoryStore, type HostSettings, type Store, type StoredRoom } from './store.ts';
import { iceConfigFor } from './turn.ts';

type Hello = Extract<ClientMsg, { t: 'hello' }>;

export interface RegistryOptions {
  loaded: LoadedConfig;
  log: Logger;
  metrics: Metrics;
  env?: NodeJS.ProcessEnv;
  store?: Store;
  /** Keep an empty room in memory this long before disposing it. */
  emptyRoomTtlMs?: number;
  /** Debounce for persisting room state. */
  saveDelayMs?: number;
}

export type JoinResult = { room: Room; info: PeerInfo } | { error: ErrorCode };

/** Passcode checks (scrypt) running at once; more are refused so guessing cannot hog the CPU. */
const MAX_PENDING_PASSCODE_CHECKS = 8;
/** Minimum time between two settings changes in one room. */
const SETTINGS_INTERVAL_MS = 1000;

/** Ad-hoc room names: printable, trimmed, 1..64 characters, no invisible formatting marks. */
export function normalizeRoomId(raw: string): string | null {
  const id = raw.normalize('NFC').trim();
  if (!id || id.length > LIMITS.roomLength) return null;
  if (cleanText(id) !== id || /[/\\]/.test(id)) return null;
  return id;
}

export class RoomRegistry {
  readonly rooms = new Map<string, Room>();
  readonly store: Store;
  private loaded: LoadedConfig;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly emptyRoomTtlMs: number;
  private readonly saveDelayMs: number;
  /** Settings in effect (may include unsaved changes by first-joiner hosts of configured rooms). */
  private readonly settings = new Map<string, HostSettings>();
  /** Settings written to storage. */
  private readonly saved = new Map<string, HostSettings>();
  private readonly settingsBusy = new Set<string>();
  private readonly settingsChangedAt = new Map<string, number>();
  private pendingPasscodeChecks = 0;
  private readonly points: PointBudget;
  private readonly creating = new Map<string, Promise<Room | ErrorCode>>();
  private readonly disposeTimers = new Map<string, NodeJS.Timeout>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly iceTimers = new Map<string, NodeJS.Timeout>();
  private readonly failures = new FailureLimiter();

  constructor(opts: RegistryOptions) {
    this.loaded = opts.loaded;
    this.log = opts.log;
    this.env = opts.env ?? process.env;
    this.store = opts.store ?? new MemoryStore();
    this.emptyRoomTtlMs = opts.emptyRoomTtlMs ?? 10 * 60 * 1000;
    this.saveDelayMs = opts.saveDelayMs ?? 2000;
    this.points = new PointBudget(opts.loaded.config.server.maxStrokePoints);
    opts.metrics.gauge('colo_rooms', 'Rooms in memory', () => this.rooms.size);
    opts.metrics.gauge('colo_participants', 'Connected participants', () =>
      [...this.rooms.values()].reduce((n, r) => n + r.peerCount, 0),
    );
  }

  get config() {
    return this.loaded.config;
  }

  get templates() {
    return this.loaded.templates;
  }

  definition(roomId: string): RoomDefinition | undefined {
    return this.config.rooms.list.find((r) => r.id === roomId);
  }

  async join(rawRoomId: string, peerId: string, conn: PeerConn, hello: Hello, identity: Identity | null, clientKey: string): Promise<JoinResult> {
    const roomId = normalizeRoomId(rawRoomId);
    if (!roomId) return { error: 'not-found' };
    const def = this.definition(roomId);
    if (!def && !this.config.rooms.allowAdhoc) return { error: 'not-found' };

    const auth = this.config.auth;
    if (auth.mode === 'trusted-headers' && !identity) return { error: 'unauthenticated' };
    const admin = isAdmin(identity, auth);
    const configuredHost = this.isConfiguredHost(identity, def);
    if (!admin && !isAllowed(identity, def?.access)) return { error: 'forbidden' };

    // Load the room first: host-set passcodes live in its stored settings.
    const room = await this.getOrCreate(roomId, def);
    if (typeof room === 'string') return { error: room };

    // A refused join must not leave the room it may have just created in memory.
    const refuse = (error: ErrorCode): JoinResult => {
      this.scheduleDispose(room);
      return { error };
    };
    const hash = def?.passcodeHash ?? this.settings.get(roomId)?.passcodeHash;
    if (hash && !configuredHost) {
      const key = `${identity?.email ?? clientKey}|${roomId}`;
      if (this.failures.blocked(key)) return refuse('rate-limited');
      if (!hello.passcode) return refuse('passcode-required');
      if (this.pendingPasscodeChecks >= MAX_PENDING_PASSCODE_CHECKS) return refuse('rate-limited');
      // Count the attempt before awaiting, so concurrent guesses cannot all pass the check above.
      this.failures.fail(key);
      this.pendingPasscodeChecks++;
      let ok: boolean;
      try {
        ok = await verifyPasscode(hello.passcode, hash);
      } finally {
        this.pendingPasscodeChecks--;
      }
      if (!ok) return refuse('passcode-invalid');
      this.failures.reset(key);
    }

    // Everything above may have awaited: re-check capacity right before joining.
    const full = room.admissionError();
    if (full) return refuse(full);
    const fromIdentity = identity && !auth.allowDisplayNameOverride;
    const name = fromIdentity ? identity.name : hello.name || identity?.name || '';
    // "Verified" means the name shown is the one from the identity provider, not a typed one.
    const verified = !!identity && name === identity.name;
    const info = room.join(peerId, conn, { hello, name, verified, configuredHost, identity });
    this.cancelDispose(roomId);
    this.sendIce(room, peerId);
    return { room, info };
  }

  leave(room: Room, peerId: string): void {
    room.leave(peerId);
    const t = this.iceTimers.get(peerId);
    if (t) clearTimeout(t);
    this.iceTimers.delete(peerId);
    this.scheduleDispose(room);
  }

  /**
   * Apply a new configuration (ConfigMap update). Running rooms get the new layout when it
   * changed, and participants who lost access are removed.
   */
  reload(loaded: LoadedConfig): void {
    this.loaded = loaded;
    for (const room of [...this.rooms.values()]) {
      const def = this.definition(room.id);
      if (!def && !this.config.rooms.allowAdhoc) {
        for (const m of room.members()) room.kick(m.id, 'not-found');
        continue;
      }
      for (const m of room.members()) {
        if (!isAdmin(m.identity, this.config.auth) && !isAllowed(m.identity, def?.access)) room.kick(m.id, 'forbidden');
      }
      room.refreshRoles(def?.hosts.length ? 'configured' : 'first-joiner', (identity) => this.isConfiguredHost(identity, def));
      const next = this.roomConfig(room.id, def);
      if (JSON.stringify(next) !== JSON.stringify(room.config)) room.reconfigure(next);
    }
    this.log.info('configuration reloaded', { source: loaded.source, rooms: this.rooms.size });
  }

  /** Delete stored state of ad-hoc rooms nobody used for `rooms.adhocTtlHours`. */
  async sweep(now = Date.now()): Promise<number> {
    const cutoff = now - this.config.rooms.adhocTtlHours * 3600_000;
    let removed = 0;
    try {
      for (const r of await this.store.list()) {
        if (r.adhoc && r.updatedAt < cutoff && !this.rooms.has(r.roomId) && !this.definition(r.roomId)) {
          await this.store.delete(r.roomId);
          this.settings.delete(r.roomId);
          this.saved.delete(r.roomId);
          removed++;
        }
      }
    } catch (e) {
      this.log.error('sweep failed', { error: String(e) });
    }
    if (removed) this.log.info('removed stale ad-hoc rooms', { count: removed });
    return removed;
  }

  /** Rooms shown in the lobby for this user. */
  lobbyRooms(identity: Identity | null): LobbyRoom[] {
    const admin = isAdmin(identity, this.config.auth);
    return this.config.rooms.list
      .filter((r) => !r.unlisted && (admin || isAllowed(identity, r.access)))
      .map((r) => ({
        id: r.id,
        title: this.settings.get(r.id)?.title ?? r.title ?? r.id,
        template: this.settings.get(r.id)?.template ?? r.template,
        passcode: !!(r.passcodeHash ?? this.settings.get(r.id)?.passcodeHash),
      }));
  }

  clientConfig(identity: Identity | null): ClientConfig {
    const c = this.config;
    return {
      protocol: PROTOCOL_VERSION,
      branding: {
        productName: c.branding.productName,
        logo: c.branding.logo ?? null,
        accentColor: c.branding.accentColor,
        lobbyMessage: c.branding.lobbyMessage ?? null,
      },
      defaultLanguage: c.i18n.defaultLanguage,
      auth: {
        mode: c.auth.mode,
        identity: identity ? { name: identity.name, email: identity.email } : null,
        allowDisplayNameOverride: c.auth.allowDisplayNameOverride,
      },
      rooms: this.lobbyRooms(identity),
      templates: this.templates.list(),
      allowAdhoc: c.rooms.allowAdhoc,
      voiceEnabled: c.voice.enabled,
      xr: { inputProfilesPath: c.xr.inputProfilesPath ?? null },
      models: { allowedOrigins: c.assets.allowedOrigins, maxBytes: c.assets.maxModelBytes },
      allowServerOverride: c.server.allowServerOverride,
    };
  }

  /** Write every room's state now (shutdown). */
  async flush(): Promise<void> {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    await Promise.all([...this.rooms.values()].map((r) => this.save(r)));
  }

  close(): void {
    for (const t of [...this.disposeTimers.values(), ...this.saveTimers.values(), ...this.iceTimers.values()]) clearTimeout(t);
    this.disposeTimers.clear();
    this.saveTimers.clear();
    this.iceTimers.clear();
  }

  // ---- internals ----

  private isConfiguredHost(identity: Identity | null, def: RoomDefinition | undefined): boolean {
    if (isAdmin(identity, this.config.auth)) return true;
    const email = identity?.email;
    return !!email && !!def?.hosts.some((h) => h.toLowerCase() === email);
  }

  private getOrCreate(roomId: string, def: RoomDefinition | undefined): Promise<Room | ErrorCode> {
    const existing = this.rooms.get(roomId);
    if (existing) return Promise.resolve(existing);
    let pending = this.creating.get(roomId);
    if (!pending) {
      pending = this.create(roomId, def).finally(() => this.creating.delete(roomId));
      this.creating.set(roomId, pending);
    }
    return pending;
  }

  private async create(roomId: string, def: RoomDefinition | undefined): Promise<Room | ErrorCode> {
    if (this.rooms.size >= this.config.server.maxRooms) return 'too-many-rooms';
    let stored: StoredRoom | null = null;
    try {
      stored = await this.store.load(roomId);
    } catch (e) {
      this.log.error('failed to load room state', { room: roomId, error: String(e) });
    }
    if (stored) {
      // Settings saved while this id was an ad-hoc room (by whoever created it) do not carry over
      // to a room defined in the configuration.
      const settings = stored.adhoc && def ? {} : stored.settings;
      this.settings.set(roomId, settings);
      this.saved.set(roomId, settings);
    }
    const config = this.roomConfig(roomId, def);
    const room = new Room(config, {
      hostMode: def?.hosts.length ? 'configured' : 'first-joiner',
      points: this.points,
      hooks: {
        onChange: () => this.scheduleSave(room),
        applySettings: (peerId, patch) => void this.applySettings(room, peerId, patch),
      },
    });
    if (stored) room.importState(stored.state);
    this.rooms.set(roomId, room);
    this.log.info('room created', { room: roomId, template: config.template, restored: !!stored });
    return room;
  }

  private roomConfig(roomId: string, def: RoomDefinition | undefined): RoomConfig {
    const s = this.settings.get(roomId) ?? {};
    const templateId = s.template && this.templates.has(s.template) ? s.template : (def?.template ?? this.config.rooms.adhocTemplate);
    const tpl = this.templates.get(templateId)!;
    const config = buildRoomConfig(roomId, s.title ?? def?.title ?? roomId, tpl, def?.overrides);
    if (s.rules) config.rules = mergeRules(config.rules, s.rules);
    return config;
  }

  private async applySettings(room: Room, peerId: string, patch: RoomSettingsPatch): Promise<void> {
    const now = Date.now();
    if (this.settingsBusy.has(room.id) || now - (this.settingsChangedAt.get(room.id) ?? 0) < SETTINGS_INTERVAL_MS) {
      return room.notify(peerId, { t: 'error', code: 'invalid-settings', message: 'too many changes, try again in a moment' });
    }
    this.settingsBusy.add(room.id);
    try {
      await this.changeSettings(room, peerId, patch);
    } finally {
      this.settingsBusy.delete(room.id);
      this.settingsChangedAt.set(room.id, Date.now());
    }
  }

  private async changeSettings(room: Room, peerId: string, patch: RoomSettingsPatch): Promise<void> {
    const def = this.definition(room.id);
    // In a room from the configuration, a host who is only host because they joined first may
    // adjust the room for the meeting, but not lock it, rename it in the lobby or change it for
    // good: their changes are not saved and end when the room empties.
    const identity = room.members().find((m) => m.id === peerId)?.identity ?? null;
    const lasting = !def || this.isConfiguredHost(identity, def);
    if (!lasting && (patch.title !== undefined || patch.passcode !== undefined)) {
      return room.notify(peerId, { t: 'error', code: 'invalid-settings', message: 'only configured hosts can change the title or passcode of this room' });
    }
    const current = this.settings.get(room.id) ?? {};
    const next: HostSettings = { ...current };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.template !== undefined) {
      if (!this.templates.has(patch.template)) return room.notify(peerId, { t: 'error', code: 'invalid-settings' });
      next.template = patch.template;
    }
    if (patch.rules) {
      next.rules = {
        ...current.rules,
        ...(patch.rules.maxParticipants !== undefined ? { maxParticipants: patch.rules.maxParticipants } : {}),
        voice: { ...current.rules?.voice, ...patch.rules.voice },
        permissions: { ...current.rules?.permissions, ...patch.rules.permissions },
      };
    }
    if (patch.passcode !== undefined) {
      // A passcode fixed in the config file (GitOps) always wins.
      if (def?.passcodeHash) return room.notify(peerId, { t: 'error', code: 'invalid-settings' });
      if (patch.passcode === null) delete next.passcodeHash;
      else {
        if (this.pendingPasscodeChecks >= MAX_PENDING_PASSCODE_CHECKS) {
          return room.notify(peerId, { t: 'error', code: 'invalid-settings', message: 'server busy, try again' });
        }
        this.pendingPasscodeChecks++;
        try {
          next.passcodeHash = await hashPasscode(patch.passcode);
        } finally {
          this.pendingPasscodeChecks--;
        }
      }
    }
    if (this.rooms.get(room.id) !== room) return; // disposed while hashing

    const prev = this.settings.get(room.id);
    this.settings.set(room.id, next);
    const config = this.roomConfig(room.id, def);
    if (room.peerCount > Math.min(config.rules.maxParticipants, config.seats.length)) {
      if (prev) this.settings.set(room.id, prev);
      else this.settings.delete(room.id);
      return room.notify(peerId, { t: 'error', code: 'invalid-settings', message: 'not enough seats for everyone present' });
    }
    if (lasting) this.saved.set(room.id, next);
    room.reconfigure(config);
    this.log.info('room settings changed', { room: room.id, by: peerId, template: config.template, saved: lasting });
  }

  private scheduleSave(room: Room): void {
    if (this.saveTimers.has(room.id)) return;
    const t = setTimeout(() => {
      this.saveTimers.delete(room.id);
      void this.save(room);
    }, this.saveDelayMs);
    t.unref?.();
    this.saveTimers.set(room.id, t);
  }

  private async save(room: Room): Promise<void> {
    try {
      await this.store.save({
        schemaVersion: 1,
        roomId: room.id,
        adhoc: !this.definition(room.id),
        updatedAt: Date.now(),
        settings: this.saved.get(room.id) ?? {},
        state: room.exportState(),
      });
    } catch (e) {
      this.log.error('failed to save room state', { room: room.id, error: String(e) });
    }
  }

  private sendIce(room: Room, peerId: string): void {
    if (!this.config.voice.enabled || !room.config.rules.voice.enabled) return;
    const ice = iceConfigFor(this.config.voice, peerId, this.env);
    room.notify(peerId, { t: 'ice', iceServers: ice.iceServers, ttl: ice.ttl });
    if (ice.ttl > 0) {
      // Refresh TURN credentials before they expire.
      const t = setTimeout(() => {
        this.iceTimers.delete(peerId);
        if (room.has(peerId)) this.sendIce(room, peerId);
      }, ice.ttl * 800);
      t.unref?.();
      this.iceTimers.set(peerId, t);
    }
  }

  private scheduleDispose(room: Room): void {
    if (room.peerCount > 0 || this.disposeTimers.has(room.id)) return;
    const t = setTimeout(() => {
      this.disposeTimers.delete(room.id);
      if (room.peerCount > 0) return;
      void this.save(room).finally(() => {
        if (room.peerCount === 0 && this.rooms.get(room.id) === room) {
          this.rooms.delete(room.id);
          room.releasePoints();
          // Drop unsaved changes made for the meeting that just ended.
          const saved = this.saved.get(room.id);
          if (saved) this.settings.set(room.id, saved);
          else this.settings.delete(room.id);
          this.settingsChangedAt.delete(room.id);
          this.log.info('room disposed', { room: room.id });
        }
      });
    }, this.emptyRoomTtlMs);
    t.unref?.();
    this.disposeTimers.set(room.id, t);
  }

  private cancelDispose(roomId: string): void {
    const t = this.disposeTimers.get(roomId);
    if (t) clearTimeout(t);
    this.disposeTimers.delete(roomId);
  }
}
