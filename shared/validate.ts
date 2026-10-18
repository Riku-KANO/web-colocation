// Validates incoming client messages on the server. Input is untrusted, so shapes and sizes
// are checked strictly and a normalized copy is returned.

import type { AvatarPose, ClientMsg, DeviceKind, Pose, RtcIceCandidate, VoiceState } from './protocol.ts';
import type { PermissionLevel, RoomSettingsPatch } from './roomConfig.ts';

export const LIMITS = {
  idLength: 64,
  nameLength: 32,
  roomLength: 64,
  /** Stroke coordinates per message (u and v count as two). */
  ptsPerMessage: 2000,
  /** Coordinates per stroke. */
  ptsPerStroke: 20000,
  strokesPerRoom: 5000,
  /** Total stroke coordinates kept per room (keeps snapshots and stored state bounded). */
  ptsPerRoom: 600_000,
  /** Max absolute coordinate allowed in the shared frame (meters). */
  coord: 1000,
  /** WebRTC SDP (a few KB for a single audio track). */
  sdpLength: 16 * 1024,
  /** ICE candidate line (usually 100-200 chars). */
  iceLength: 1024,
  passcodeLength: 128,
  titleLength: 80,
} as const;

const DEVICES: readonly DeviceKind[] = ['desktop', 'ar', 'vr'];
const VOICES: readonly VoiceState[] = ['off', 'muted', 'on'];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

function id(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= LIMITS.idLength ? v : null;
}

function color(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}

function num(v: unknown, abs: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= abs;
}

function numArray(v: unknown, len: number, abs: number): number[] | null {
  if (!Array.isArray(v) || v.length !== len) return null;
  for (const x of v) if (!num(x, abs)) return null;
  return v as number[];
}

export function parsePose(v: unknown): Pose | null {
  if (!isObj(v)) return null;
  const p = numArray(v.p, 3, LIMITS.coord);
  const q = numArray(v.q, 4, 1.01);
  if (!p || !q) return null;
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 0.5) return null;
  return {
    p: [p[0], p[1], p[2]],
    q: [q[0] / len, q[1] / len, q[2] / len, q[3] / len],
  };
}

function parseAvatarPose(v: unknown): AvatarPose | null {
  if (!isObj(v) || !Array.isArray(v.hands) || v.hands.length !== 2) return null;
  const head = parsePose(v.head);
  if (!head) return null;
  const hand = (h: unknown): Pose | null | undefined => (h === null ? null : (parsePose(h) ?? undefined));
  const l = hand(v.hands[0]);
  const r = hand(v.hands[1]);
  if (l === undefined || r === undefined) return null;
  return { head, hands: [l, r] };
}

function uvPoints(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length % 2 !== 0 || v.length > LIMITS.ptsPerMessage) return null;
  for (const x of v) if (!num(x, 2)) return null;
  return v as number[];
}

/** Room epoch carried by state-changing messages. */
function epoch(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
}

const PERMISSIONS: readonly PermissionLevel[] = ['everyone', 'hosts'];

function permission(v: unknown): PermissionLevel | null | undefined {
  if (v === undefined) return undefined;
  return PERMISSIONS.includes(v as PermissionLevel) ? (v as PermissionLevel) : null;
}

/** Host settings patch. Unknown keys are dropped; invalid values reject the whole message. */
function settingsPatch(v: unknown): RoomSettingsPatch | null {
  if (!isObj(v)) return null;
  const out: RoomSettingsPatch = {};
  if (v.title !== undefined) {
    const title = str(v.title, LIMITS.titleLength);
    if (title === null || !title.trim()) return null;
    out.title = title.trim();
  }
  if (v.template !== undefined) {
    const template = id(v.template);
    if (!template) return null;
    out.template = template;
  }
  if (v.passcode !== undefined) {
    if (v.passcode === null) out.passcode = null;
    else {
      const pc = str(v.passcode, LIMITS.passcodeLength);
      if (!pc) return null;
      out.passcode = pc;
    }
  }
  if (v.rules !== undefined) {
    if (!isObj(v.rules)) return null;
    const r = v.rules;
    const rules: NonNullable<RoomSettingsPatch['rules']> = {};
    if (r.maxParticipants !== undefined) {
      if (!Number.isInteger(r.maxParticipants) || (r.maxParticipants as number) < 1 || (r.maxParticipants as number) > 256) return null;
      rules.maxParticipants = r.maxParticipants as number;
    }
    if (r.voice !== undefined) {
      if (!isObj(r.voice) || (r.voice.enabled !== undefined && typeof r.voice.enabled !== 'boolean')) return null;
      rules.voice = r.voice.enabled === undefined ? {} : { enabled: r.voice.enabled as boolean };
    }
    if (r.permissions !== undefined) {
      if (!isObj(r.permissions)) return null;
      const perms: NonNullable<NonNullable<RoomSettingsPatch['rules']>['permissions']> = {};
      for (const key of ['clearBoard', 'resetObjects', 'editSettings'] as const) {
        const level = permission(r.permissions[key]);
        if (level === null) return null;
        if (level !== undefined) perms[key] = level;
      }
      rules.permissions = perms;
    }
    out.rules = rules;
  }
  return out;
}

function device(v: unknown): DeviceKind | null {
  return DEVICES.includes(v as DeviceKind) ? (v as DeviceKind) : null;
}

function voice(v: unknown): VoiceState | null {
  return VOICES.includes(v as VoiceState) ? (v as VoiceState) : null;
}

/** Maps omitted (undefined) and null to null; otherwise returns the parsed value, or undefined if invalid. */
function nullable<T>(v: unknown, parse: (v: unknown) => T | null): T | null | undefined {
  if (v === undefined || v === null) return null;
  return parse(v) ?? undefined;
}

function iceCandidate(v: unknown): RtcIceCandidate | null {
  if (!isObj(v)) return null;
  const candidate = str(v.candidate, LIMITS.iceLength);
  const sdpMid = nullable(v.sdpMid, (x) => str(x, LIMITS.idLength));
  const sdpMLineIndex = nullable(v.sdpMLineIndex, (x) =>
    Number.isInteger(x) && (x as number) >= 0 && (x as number) < 256 ? (x as number) : null,
  );
  const usernameFragment = nullable(v.usernameFragment, (x) => str(x, 256));
  if (candidate === null || sdpMid === undefined || sdpMLineIndex === undefined || usernameFragment === undefined) {
    return null;
  }
  if (sdpMid === null && sdpMLineIndex === null) return null; // can't tell which m-line it belongs to
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

/** Returns null if invalid, otherwise a new normalized object. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'hello': {
      const room = str(raw.room, LIMITS.roomLength);
      const name = str(raw.name, LIMITS.nameLength);
      const c = color(raw.color);
      const d = device(raw.device);
      const space = str(raw.space, LIMITS.roomLength);
      const vs = raw.voice === undefined ? 'off' : voice(raw.voice);
      const passcode = raw.passcode === undefined ? undefined : str(raw.passcode, LIMITS.passcodeLength);
      if (typeof raw.v !== 'number' || !room || name === null || !c || !d || space === null || !vs || passcode === null) {
        return null;
      }
      return {
        t: 'hello',
        v: raw.v,
        room,
        name,
        color: c,
        device: d,
        space,
        voice: vs,
        ...(passcode !== undefined ? { passcode } : {}),
      };
    }
    case 'profile': {
      const d = device(raw.device);
      const space = str(raw.space, LIMITS.roomLength);
      if (!d || space === null) return null;
      return { t: 'profile', device: d, space };
    }
    case 'pose': {
      const pose = parseAvatarPose(raw.pose);
      return pose ? { t: 'pose', pose } : null;
    }
    case 'grab': {
      const e = epoch(raw.e);
      const i = id(raw.id);
      return i && e !== null ? { t: 'grab', e, id: i } : null;
    }
    case 'move':
    case 'release': {
      const e = epoch(raw.e);
      const i = id(raw.id);
      const pose = parsePose(raw.pose);
      if (!i || !pose || e === null) return null;
      return { t: raw.t, e, id: i, pose };
    }
    case 'stroke': {
      const e = epoch(raw.e);
      const i = id(raw.id);
      const board = id(raw.board);
      const c = color(raw.color);
      const pts = uvPoints(raw.pts);
      if (e === null || !i || !board || !c || !pts || !num(raw.width, 0.1) || raw.width <= 0) return null;
      return { t: 'stroke', e, id: i, board, color: c, width: raw.width, pts };
    }
    case 'stroke-pts': {
      const e = epoch(raw.e);
      const i = id(raw.id);
      const pts = uvPoints(raw.pts);
      return e !== null && i && pts ? { t: 'stroke-pts', e, id: i, pts } : null;
    }
    case 'stroke-end': {
      const e = epoch(raw.e);
      const i = id(raw.id);
      return e !== null && i ? { t: 'stroke-end', e, id: i } : null;
    }
    case 'board-clear': {
      const e = epoch(raw.e);
      const board = id(raw.board);
      return e !== null && board ? { t: 'board-clear', e, board } : null;
    }
    case 'room-settings': {
      const e = epoch(raw.e);
      const settings = settingsPatch(raw.settings);
      return e !== null && settings ? { t: 'room-settings', e, settings } : null;
    }
    case 'voice': {
      const state = voice(raw.state);
      return state ? { t: 'voice', state } : null;
    }
    case 'reset-objects': {
      const e = epoch(raw.e);
      return e !== null ? { t: 'reset-objects', e } : null;
    }
    case 'rtc-offer':
    case 'rtc-answer': {
      const to = id(raw.to);
      const sdp = str(raw.sdp, LIMITS.sdpLength);
      if (!to || !sdp) return null;
      return { t: raw.t, to, sdp };
    }
    case 'rtc-ice': {
      const to = id(raw.to);
      const candidate = iceCandidate(raw.candidate);
      return to && candidate ? { t: 'rtc-ice', to, candidate } : null;
    }
    case 'ping':
      return num(raw.ts, Number.MAX_SAFE_INTEGER) ? { t: 'ping', ts: raw.ts } : null;
    default:
      return null;
  }
}
