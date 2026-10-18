// クライアント / サーバー間で共有するワイヤプロトコル。
//
// 座標系の約束（ネイティブクライアント — Android XR / Unity など — と相互運用するための契約）:
//   - すべての位置・回転は「共有座標系 (shared frame)」で表す。
//   - 右手系・Y 軸が上・単位はメートル。原点はテーブル天板の中心 (y = 0 が天板面)。
//   - クォータニオンは [x, y, z, w]。
//   - Unity (左手系) から送る場合は z を反転し、クォータニオンは (-x, -y, z, w) に変換すること。

export const PROTOCOL_VERSION = 2;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Pose {
  p: Vec3;
  q: Quat;
}

export type DeviceKind = 'desktop' | 'ar' | 'vr';

/** 音声通話の参加状態。off = 不参加、muted = 参加中 (マイク無効・聞くだけ)、on = 参加中 (マイク有効)。 */
export type VoiceState = 'off' | 'muted' | 'on';

/** RTCIceCandidateInit の JSON 表現 (RTCIceCandidate.toJSON() の値)。 */
export interface RtcIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  seat: number;
  device: DeviceKind;
  /** 物理的に同じ部屋にいるユーザー同士が共有する任意の文字列。空文字は「単独」。 */
  space: string;
  voice: VoiceState;
}

/** 頭と左右の手 (コントローラー) の姿勢。共有座標系。 */
export interface AvatarPose {
  head: Pose;
  /** [left, right]。追跡されていなければ null。 */
  hands: [Pose | null, Pose | null];
}

export type ObjectKind = 'cube' | 'sphere' | 'cone' | 'torus' | 'pen';

export interface ObjectState {
  id: string;
  kind: ObjectKind;
  color: string;
  pose: Pose;
  /** 現在掴んでいるピアの id。誰も掴んでいなければ null。 */
  owner: string | null;
}

export interface Stroke {
  id: string;
  board: string;
  author: string;
  color: string;
  /** 線幅 (メートル)。 */
  width: number;
  /** ボード上の正規化座標 [u0, v0, u1, v1, ...]。(0,0) が左下、(1,1) が右上。 */
  pts: number[];
  done: boolean;
}

export interface RoomSnapshot {
  peers: PeerInfo[];
  poses: Record<string, AvatarPose>;
  objects: ObjectState[];
  strokes: Stroke[];
}

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
      /** 省略時は 'off'。再接続時は現在の状態を載せて入り直す。 */
      voice?: VoiceState;
    }
  | { t: 'profile'; device: DeviceKind; space: string }
  | { t: 'voice'; state: VoiceState }
  | { t: 'pose'; pose: AvatarPose }
  | { t: 'grab'; id: string }
  | { t: 'move'; id: string; pose: Pose }
  | { t: 'release'; id: string; pose: Pose }
  | { t: 'stroke'; id: string; board: string; color: string; width: number; pts: number[] }
  | { t: 'stroke-pts'; id: string; pts: number[] }
  | { t: 'stroke-end'; id: string }
  | { t: 'board-clear'; board: string }
  | { t: 'reset-objects' }
  /**
   * WebRTC のシグナリング。サーバーは同じルームの `to` へ `from` を付けて中継するだけ。
   * 中継するのは送り主と宛先の両方が音声に参加している (voice !== 'off') ときに限る。
   * offer を出すのは id が小さい (文字列比較) 側。詳しくは src/voice/mesh.ts。
   */
  | { t: 'rtc-offer'; to: string; sdp: string }
  | { t: 'rtc-answer'; to: string; sdp: string }
  | { t: 'rtc-ice'; to: string; candidate: RtcIceCandidate }
  | { t: 'ping'; ts: number };

// ---- Server -> Client ----

export type ServerMsg =
  | { t: 'welcome'; v: number; room: string; self: PeerInfo; snapshot: RoomSnapshot }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-update'; peer: PeerInfo }
  | { t: 'peer-leave'; id: string }
  | { t: 'pose'; id: string; pose: AvatarPose }
  /** 所有権の変化。pose は解放時の最終姿勢など、確定した姿勢があれば付く。 */
  | { t: 'owner'; id: string; owner: string | null; pose?: Pose }
  | { t: 'move'; id: string; pose: Pose }
  | { t: 'grab-denied'; id: string; owner: string | null; pose: Pose }
  | { t: 'objects'; objects: ObjectState[] }
  | { t: 'stroke'; stroke: Stroke }
  | { t: 'stroke-pts'; id: string; pts: number[] }
  | { t: 'stroke-end'; id: string }
  | { t: 'board-clear'; board: string }
  | { t: 'rtc-offer'; from: string; sdp: string }
  | { t: 'rtc-answer'; from: string; sdp: string }
  | { t: 'rtc-ice'; from: string; candidate: RtcIceCandidate }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string };

// ---- 共有空間のレイアウト ----

export interface Seat {
  /** 共有座標系での着席位置 (水平面)。 */
  x: number;
  z: number;
}

/** テーブル (長辺が X 軸) を囲む席。0 と 1 は向かい合わせ。ホワイトボードは +X 側。 */
export const SEATS: readonly Seat[] = [
  { x: -0.1, z: 0.75 },
  { x: -0.1, z: -0.75 },
  { x: -1.05, z: 0 },
  { x: 0.45, z: 0.75 },
  { x: 0.45, z: -0.75 },
  { x: -0.6, z: 0.75 },
  { x: -0.6, z: -0.75 },
];

export function seatAt(index: number): Seat {
  return SEATS[((index % SEATS.length) + SEATS.length) % SEATS.length];
}

export const TABLE = { width: 1.4, depth: 0.8, height: 0.72 } as const;

export const BOARD = {
  id: 'wb1',
  width: 1.2,
  height: 0.8,
  /** 共有座標系でのボード中心。-X 方向 (テーブル側) を向く。 */
  center: [1.0, 0.5, 0] as Vec3,
  /** Y 軸回りの回転 (ラジアン)。PlaneGeometry の法線 +Z を -X に向ける。 */
  yaw: -Math.PI / 2,
} as const;

/** 新しいルームの初期配置。 */
export function defaultObjects(): ObjectState[] {
  const q: Quat = [0, 0, 0, 1];
  // ペンは軸が -Z。卓上に寝かせるため X 軸回りに回転させない (もともと水平)。
  const penRot = (yaw: number): Quat => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  return [
    { id: 'cube', kind: 'cube', color: '#e4572e', pose: { p: [-0.35, 0.05, 0], q }, owner: null },
    { id: 'sphere', kind: 'sphere', color: '#4c8bf5', pose: { p: [-0.1, 0.06, 0.05], q }, owner: null },
    { id: 'cone', kind: 'cone', color: '#f2c14e', pose: { p: [0.15, 0.06, -0.05], q }, owner: null },
    { id: 'torus', kind: 'torus', color: '#3fb27f', pose: { p: [0.4, 0.05, 0.05], q }, owner: null },
    { id: 'pen-black', kind: 'pen', color: '#222222', pose: { p: [0.2, 0.012, 0.3], q: penRot(Math.PI / 2) }, owner: null },
    { id: 'pen-red', kind: 'pen', color: '#d62828', pose: { p: [0.2, 0.012, -0.3], q: penRot(-Math.PI / 2) }, owner: null },
  ];
}
