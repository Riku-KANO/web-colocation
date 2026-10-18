// サーバー側で受信メッセージを検証する。信頼できない入力なので、形と大きさを厳しく見る。

import type { AvatarPose, ClientMsg, DeviceKind, Pose, RtcIceCandidate, VoiceState } from './protocol.ts';

export const LIMITS = {
  idLength: 64,
  nameLength: 32,
  roomLength: 64,
  /** 1 メッセージあたりのストローク座標数 (u,v を 2 つと数える)。 */
  ptsPerMessage: 2000,
  /** 1 ストロークあたりの座標数。 */
  ptsPerStroke: 20000,
  strokesPerRoom: 5000,
  /** 共有座標系で許容する座標の絶対値 (メートル)。 */
  coord: 1000,
  /** WebRTC の SDP (音声 1 本なら数 KB)。 */
  sdpLength: 16 * 1024,
  /** ICE 候補の candidate 行 (通常 100〜200 文字)。 */
  iceLength: 1024,
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

function device(v: unknown): DeviceKind | null {
  return DEVICES.includes(v as DeviceKind) ? (v as DeviceKind) : null;
}

function voice(v: unknown): VoiceState | null {
  return VOICES.includes(v as VoiceState) ? (v as VoiceState) : null;
}

/** 省略 (undefined) と null は null に、それ以外は検証して値か undefined (不正) を返す。 */
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
  if (sdpMid === null && sdpMLineIndex === null) return null; // どの m 行の候補か分からない
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

/** 不正なら null。正規化済みの新しいオブジェクトを返す。 */
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
      if (typeof raw.v !== 'number' || !room || name === null || !c || !d || space === null || !vs) return null;
      return { t: 'hello', v: raw.v, room, name, color: c, device: d, space, voice: vs };
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
      const i = id(raw.id);
      return i ? { t: 'grab', id: i } : null;
    }
    case 'move':
    case 'release': {
      const i = id(raw.id);
      const pose = parsePose(raw.pose);
      if (!i || !pose) return null;
      return { t: raw.t, id: i, pose };
    }
    case 'stroke': {
      const i = id(raw.id);
      const board = id(raw.board);
      const c = color(raw.color);
      const pts = uvPoints(raw.pts);
      if (!i || !board || !c || !pts || !num(raw.width, 0.1) || raw.width <= 0) return null;
      return { t: 'stroke', id: i, board, color: c, width: raw.width, pts };
    }
    case 'stroke-pts': {
      const i = id(raw.id);
      const pts = uvPoints(raw.pts);
      return i && pts ? { t: 'stroke-pts', id: i, pts } : null;
    }
    case 'stroke-end': {
      const i = id(raw.id);
      return i ? { t: 'stroke-end', id: i } : null;
    }
    case 'board-clear': {
      const board = id(raw.board);
      return board ? { t: 'board-clear', board } : null;
    }
    case 'voice': {
      const state = voice(raw.state);
      return state ? { t: 'voice', state } : null;
    }
    case 'reset-objects':
      return { t: 'reset-objects' };
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
