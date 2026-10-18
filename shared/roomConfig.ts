// Resolved room configuration shared by server and client (types + tiny pure helpers only).
// The server validates config files with zod (server/config/schema.ts) and resolves templates
// into a RoomConfig; clients receive it in `welcome` / `config` and build the scene from it.
//
// Shared-frame contract (also documented in shared/protocol.ts):
//   right-handed, +Y up, meters. The origin is the room anchor:
//     anchor.kind = 'table' → centre of the main table top, the floor is at y = -floorOffset
//     anchor.kind = 'floor' → a point on the floor (floorOffset = 0)

import type { Pose, Vec3 } from './protocol.ts';

/** A plain string, or a map of language code → string (e.g. { en: "Design review", ja: "デザインレビュー" }). */
export type Localized = string | Readonly<Record<string, string>>;

export function localize(text: Localized | undefined, lang: string, fallback = ''): string {
  if (text === undefined) return fallback;
  if (typeof text === 'string') return text;
  return text[lang] ?? text.en ?? Object.values(text)[0] ?? fallback;
}

export interface AnchorSpec {
  kind: 'table' | 'floor';
  /** Height of the shared origin above the floor (m). 0 for floor anchors. */
  floorOffset: number;
}

export interface EnvironmentSpec {
  /** Background colour used in VR and on desktop (AR shows passthrough). */
  background: string;
  floor: 'grid' | 'plain' | 'none';
  floorColor: string;
  /** Multiplier for the default lights (1 = default). */
  light: number;
}

export interface TableSpec {
  id: string;
  shape: 'rect' | 'round';
  /** rect: size along X / Z. round: width is the diameter (depth is ignored). */
  width: number;
  depth: number;
  /** Height of the table top above the floor (m). */
  height: number;
  color: string;
  /** Position of the table top centre on the floor plane, in the shared frame. */
  x: number;
  z: number;
  yaw: number;
}

export interface SeatSpec {
  x: number;
  z: number;
  /** Facing direction: rotation about +Y applied to -Z. Seats around a table face its centre. */
  yaw: number;
}

export interface BoardSpec {
  id: string;
  /** Centre of the drawing surface in the shared frame. */
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y. 0 means the board faces +Z. */
  yaw: number;
  width: number;
  height: number;
  background: string;
}

export type ObjectKind = 'cube' | 'sphere' | 'cone' | 'torus' | 'pen' | 'model';

export interface ModelSpec {
  /** `/room-assets/...` path or an https URL from an allowed origin. */
  src: string;
  /** Uniform scale applied to the loaded model. */
  scale: number;
  /** Near-grab radius (m). Computed from the model bounds when omitted. */
  grabRadius?: number;
}

export interface ObjectSpec {
  id: string;
  kind: ObjectKind;
  color: string;
  /** Initial pose in the shared frame. */
  pose: Pose;
  /** Uniform scale for primitive kinds. */
  scale?: number;
  model?: ModelSpec;
}

export type PermissionLevel = 'everyone' | 'hosts';

export interface RoomRules {
  maxParticipants: number;
  voice: { enabled: boolean };
  permissions: {
    clearBoard: PermissionLevel;
    resetObjects: PermissionLevel;
    editSettings: PermissionLevel;
  };
}

/** Everything a client needs to build a room. Never contains secrets or ACLs. */
export interface RoomConfig {
  id: string;
  title: Localized;
  template: string;
  anchor: AnchorSpec;
  environment: EnvironmentSpec;
  tables: TableSpec[];
  seats: SeatSpec[];
  boards: BoardSpec[];
  objects: ObjectSpec[];
  rules: RoomRules;
}

/** Settings a host may change in the app (validated and persisted by the server). */
export interface RoomSettingsPatch {
  title?: string;
  template?: string;
  rules?: {
    maxParticipants?: number;
    voice?: { enabled?: boolean };
    permissions?: Partial<RoomRules['permissions']>;
  };
  /** New passcode; null removes it. Ignored when the passcode is fixed by the config file. */
  passcode?: string | null;
}

// ---- geometry helpers shared by server and client ----

/** Facing yaw for a seat at (x, z) that looks at the shared origin. */
export function yawFacingOrigin(x: number, z: number): number {
  return Math.atan2(x, z);
}

/** Unit vector (x, z) a seat with this yaw is facing. */
export function seatForward(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/** Eye position of someone sitting on the seat, in the shared frame. */
export function seatEye(seat: SeatSpec, anchor: AnchorSpec, eyeHeight = 1.2): Vec3 {
  return [seat.x, eyeHeight - anchor.floorOffset, seat.z];
}
