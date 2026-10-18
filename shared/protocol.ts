// Wire protocol shared by the client and the server (JSON text frames over WebSocket).
//
// Coordinate contract (also for native clients such as Android XR / Unity):
//   - Every position / rotation is expressed in the room's *shared frame*:
//     right-handed, +Y up, meters; the origin is the room anchor (see shared/roomConfig.ts).
//   - Quaternions are [x, y, z, w].
//   - Unity (left-handed): negate z for positions and send quaternions as (-x, -y, z, w).
//
// Epochs: every state-changing client message carries the room epoch `e` it was produced in.
// When a host changes the room settings the epoch increases and the server drops messages
// that still carry the old epoch (e.g. a grab sent just before the layout changed).

import type { ObjectKind, ObjectSpec, RoomConfig, RoomSettingsPatch } from './roomConfig.ts';

export type { ObjectKind } from './roomConfig.ts';

export const PROTOCOL_VERSION = 3;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Pose {
  p: Vec3;
  q: Quat;
}

export type DeviceKind = 'desktop' | 'ar' | 'vr';

/** Voice participation: off = not in the call, muted = listening only, on = microphone live. */
export type VoiceState = 'off' | 'muted' | 'on';

export type Role = 'host' | 'member';

/** JSON form of RTCIceCandidateInit (RTCIceCandidate.toJSON()). */
export interface RtcIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/** ICE server entry handed to clients (TURN credentials are short-lived). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  seat: number;
  device: DeviceKind;
  /** Arbitrary string shared by people who are physically in the same room ("" = alone). */
  space: string;
  voice: VoiceState;
  role: Role;
  /** True when the name comes from the SSO identity (trusted-headers auth). */
  verified: boolean;
}

/** Head and both hands (controllers), in the shared frame. */
export interface AvatarPose {
  head: Pose;
  /** [left, right]; null when not tracked. */
  hands: [Pose | null, Pose | null];
}

export interface ObjectState extends ObjectSpec {
  kind: ObjectKind;
  pose: Pose;
  /** Peer id holding the object, or null. */
  owner: string | null;
}

export interface Stroke {
  id: string;
  board: string;
  author: string;
  color: string;
  /** Line width in meters. */
  width: number;
  /** Normalized board coordinates [u0, v0, u1, v1, ...]; (0,0) bottom-left, (1,1) top-right. */
  pts: number[];
  done: boolean;
}

export interface RoomSnapshot {
  peers: PeerInfo[];
  poses: Record<string, AvatarPose>;
  objects: ObjectState[];
  strokes: Stroke[];
}

export type ErrorCode =
  | 'protocol-mismatch'
  | 'not-found'
  | 'room-full'
  | 'passcode-required'
  | 'passcode-invalid'
  | 'forbidden'
  | 'unauthenticated'
  | 'rate-limited'
  | 'too-many-rooms'
  /** Non-fatal: the action needs the host role. */
  | 'not-allowed'
  /** Non-fatal: a per-room limit (e.g. stroke budget) was reached. */
  | 'limit'
  /** Non-fatal: rejected room-settings change. */
  | 'invalid-settings';

/** Errors after which the client must not auto-reconnect with the same parameters. */
export const FATAL_ERRORS: readonly ErrorCode[] = [
  'protocol-mismatch',
  'not-found',
  'room-full',
  'passcode-required',
  'passcode-invalid',
  'forbidden',
  'unauthenticated',
  'rate-limited',
  'too-many-rooms',
];

/** WebSocket close code used together with a fatal `error`. */
export const CLOSE_FATAL = 4003;
/** Close code sent when the server restarts (clients reconnect). */
export const CLOSE_RESTART = 1012;

// ---- Client -> Server ----

export type ClientMsg =
  | {
      t: 'hello';
      v: number;
      room: string;
      name: string;
      color: string;
      device: DeviceKind;
      space: string;
      /** Defaults to 'off'. On reconnect the client re-sends its current state. */
      voice?: VoiceState;
      passcode?: string;
    }
  | { t: 'profile'; device: DeviceKind; space: string }
  | { t: 'voice'; state: VoiceState }
  | { t: 'pose'; pose: AvatarPose }
  | { t: 'grab'; e: number; id: string }
  | { t: 'move'; e: number; id: string; pose: Pose }
  | { t: 'release'; e: number; id: string; pose: Pose }
  | { t: 'stroke'; e: number; id: string; board: string; color: string; width: number; pts: number[] }
  | { t: 'stroke-pts'; e: number; id: string; pts: number[] }
  | { t: 'stroke-end'; e: number; id: string }
  | { t: 'board-clear'; e: number; board: string }
  | { t: 'reset-objects'; e: number }
  | { t: 'room-settings'; e: number; settings: RoomSettingsPatch }
  /**
   * WebRTC signalling. The server relays to `to` (same room) adding `from`, and only when both
   * peers have joined voice (voice !== 'off'). The peer with the smaller id sends the offer.
   */
  | { t: 'rtc-offer'; to: string; sdp: string }
  | { t: 'rtc-answer'; to: string; sdp: string }
  | { t: 'rtc-ice'; to: string; candidate: RtcIceCandidate }
  | { t: 'ping'; ts: number };

// ---- Server -> Client ----

export type ServerMsg =
  | {
      t: 'welcome';
      v: number;
      room: string;
      self: PeerInfo;
      epoch: number;
      config: RoomConfig;
      snapshot: RoomSnapshot;
    }
  /** The room was reconfigured: replace the scene and all state. */
  | { t: 'config'; epoch: number; config: RoomConfig; self: PeerInfo; snapshot: RoomSnapshot }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-update'; peer: PeerInfo }
  | { t: 'peer-leave'; id: string }
  | { t: 'pose'; id: string; pose: AvatarPose }
  /** Ownership change. `pose` is the settled pose when there is one (e.g. on release). */
  | { t: 'owner'; id: string; owner: string | null; pose?: Pose }
  | { t: 'move'; id: string; pose: Pose }
  | { t: 'grab-denied'; id: string; owner: string | null; pose: Pose }
  | { t: 'objects'; objects: ObjectState[] }
  | { t: 'stroke'; stroke: Stroke }
  | { t: 'stroke-pts'; id: string; pts: number[] }
  | { t: 'stroke-end'; id: string }
  | { t: 'board-clear'; board: string }
  /** ICE servers for voice (sent after joining; refreshed before TURN credentials expire). */
  | { t: 'ice'; iceServers: IceServer[]; ttl: number }
  | { t: 'rtc-offer'; from: string; sdp: string }
  | { t: 'rtc-answer'; from: string; sdp: string }
  | { t: 'rtc-ice'; from: string; candidate: RtcIceCandidate }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: ErrorCode; message?: string };
