// リモート参加者の表示 (頭・両手・名札) と、その人の声。姿勢は共有座標系で受け取り、滑らかに追従させる。
// 同じ「同室 ID (space)」の XR 参加者は実物がパススルーで見えるので、名札だけを出す。
// 声は頭に付けた PositionalAudio から鳴らす (空間音声)。話している間は名札の縁と頭が光る。

import {
  AudioListener,
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  PositionalAudio,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three';
import { seatAt, type AvatarPose, type PeerInfo, type Pose } from '../../shared/protocol.ts';
import { readPose, smoothing } from '../util/pose.ts';
import { LevelMeter } from '../voice/level.ts';

const FOLLOW_RATE = 14;
/** この距離 (m) までは減衰させない。テーブルを挟んだ相手 (約 1.5 m) が自然な大きさに聞こえる値。 */
const VOICE_REF_DISTANCE = 1;
const VOICE_ROLLOFF = 1.2;
const LABEL_Y = 0.2;

/** 1 人分の受信音声。 */
class RemoteVoice {
  readonly audio: PositionalAudio;
  readonly meter: LevelMeter;
  private readonly sink: HTMLAudioElement;
  private muted = false;

  constructor(stream: MediaStream, listener: AudioListener) {
    // Chrome では、リモートの WebRTC ストリームはメディア要素にも繋いでおかないと Web Audio 側が無音になる。
    // 音はこの要素からは出さない (muted)。
    this.sink = new Audio();
    this.sink.muted = true;
    this.sink.srcObject = stream;
    void this.sink.play().catch(() => {});

    this.audio = new PositionalAudio(listener);
    this.audio.setMediaStreamSource(stream);
    this.audio.setDistanceModel('inverse');
    this.audio.setRefDistance(VOICE_REF_DISTANCE);
    this.audio.setRolloffFactor(VOICE_ROLLOFF);
    // 人の声は正面に強い。パンナーの正面は +Z、アバターの正面は -Z なので裏返して付ける。
    this.audio.setDirectionalCone(160, 320, 0.6);
    this.audio.rotation.y = Math.PI;
    // 音量はパンナーより前 (距離減衰の前) で測る
    this.meter = new LevelMeter(this.audio.source!);
  }

  /** 同室の相手は肉声が聞こえるので、スピーカーからは鳴らさない (二重に聞こえる・エコーになる)。 */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.audio.setVolume(muted ? 0 : 1);
  }

  dispose(): void {
    this.meter.dispose();
    this.audio.removeFromParent();
    this.audio.disconnect();
    this.sink.srcObject = null;
  }
}

class Tracked {
  readonly obj: Group;
  readonly p = new Vector3();
  readonly q = new Quaternion();
  has = false;

  constructor(obj: Group) {
    this.obj = obj;
    obj.visible = false;
  }

  set(pose: Pose | null): void {
    if (!pose) {
      this.has = false;
      return;
    }
    readPose(pose, this.p, this.q);
    if (!this.has) {
      this.obj.position.copy(this.p);
      this.obj.quaternion.copy(this.q);
    }
    this.has = true;
  }

  update(k: number, visible: boolean): void {
    this.obj.visible = this.has && visible;
    if (!this.has) return;
    this.obj.position.lerp(this.p, k);
    this.obj.quaternion.slerp(this.q, k);
  }
}

export class RemoteAvatar {
  readonly root = new Group();
  info: PeerInfo;
  /** true のときは身体を隠して名札だけにする (同室)。 */
  colocated = false;

  private readonly head: Tracked;
  private readonly hands: [Tracked, Tracked];
  private readonly headBody: Group;
  private readonly label: Sprite;
  /** 話している間だけ名札の周りに出す光。 */
  private readonly halo: Sprite;
  private readonly bodyMat: MeshStandardMaterial;
  private readonly baseColor: Color;
  private voice: RemoteVoice | null = null;

  constructor(info: PeerInfo) {
    this.info = info;
    this.root.name = `avatar:${info.id}`;
    this.baseColor = new Color(info.color);
    this.bodyMat = new MeshStandardMaterial({ color: info.color, roughness: 0.6 });

    const headGroup = new Group();
    this.headBody = new Group();
    const skull = new Mesh(new SphereGeometry(0.1, 24, 16), this.bodyMat);
    skull.scale.set(0.9, 1.05, 1);
    const visor = new Mesh(
      new BoxGeometry(0.15, 0.06, 0.05),
      new MeshStandardMaterial({ color: '#111111', roughness: 0.2, metalness: 0.4 }),
    );
    visor.position.set(0, 0.01, -0.085); // 正面 (-Z)
    this.headBody.add(skull, visor);
    this.label = makeLabel(info);
    this.label.position.set(0, LABEL_Y, 0);
    this.halo = new Sprite(
      new SpriteMaterial({ map: haloTexture(), color: info.color, depthTest: false, transparent: true, opacity: 0 }),
    );
    this.halo.scale.set(0.38, 0.14, 1);
    this.halo.position.set(0, LABEL_Y, 0);
    this.halo.renderOrder = 9; // 名札 (10) の後ろ
    this.halo.visible = false;
    headGroup.add(this.headBody, this.halo, this.label);
    this.head = new Tracked(headGroup);

    const mkHand = () => {
      const g = new Group();
      const palm = new Mesh(new SphereGeometry(0.035, 16, 12), this.bodyMat);
      palm.scale.set(1, 0.6, 1.3);
      g.add(palm);
      return new Tracked(g);
    };
    this.hands = [mkHand(), mkHand()];
    this.root.add(this.head.obj, this.hands[0].obj, this.hands[1].obj);

    // 姿勢が届くまでは (相手のタブが裏にある等)、席に座ってテーブルを見ている姿で出しておく
    const seat = seatAt(info.seat);
    const yaw = Math.atan2(seat.x, seat.z); // -Z (正面) を席→中心方向へ向ける
    this.head.set({ p: [seat.x, 0.45, seat.z], q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] });
  }

  /** 話している度合い (0..1)。音声が届いていなければ 0。 */
  get level(): number {
    return this.voice?.meter.level ?? 0;
  }

  get speaking(): boolean {
    return this.voice?.meter.speaking ?? false;
  }

  setInfo(info: PeerInfo): void {
    const relabel =
      info.name !== this.info.name ||
      info.device !== this.info.device ||
      info.color !== this.info.color ||
      info.voice !== this.info.voice;
    this.info = info;
    this.baseColor.set(info.color);
    this.bodyMat.color.set(info.color);
    this.halo.material.color.set(info.color);
    if (relabel) {
      const old = this.label.material;
      this.label.material = makeLabel(info).material;
      old.map?.dispose();
      old.dispose();
    }
  }

  setPose(pose: AvatarPose): void {
    this.head.set(pose.head);
    this.hands[0].set(pose.hands[0]);
    this.hands[1].set(pose.hands[1]);
  }

  /** 受信した音声を頭に付ける。null で外す。 */
  setVoice(stream: MediaStream | null, listener: AudioListener | null): void {
    this.voice?.dispose();
    this.voice = null;
    if (!stream || !listener) return;
    this.voice = new RemoteVoice(stream, listener);
    this.head.obj.add(this.voice.audio);
  }

  update(dt: number): void {
    const k = smoothing(FOLLOW_RATE, dt);
    this.head.update(k, true);
    this.headBody.visible = !this.colocated;
    this.hands[0].update(k, !this.colocated);
    this.hands[1].update(k, !this.colocated);

    const level = this.voice ? this.voice.meter.update(dt) : 0;
    this.voice?.setMuted(this.colocated);
    this.halo.visible = level > 0.02;
    this.halo.material.opacity = Math.min(1, level * 1.4);
    const s = 1 + 0.08 * level;
    this.label.scale.set(0.32 * s, 0.08 * s, 1);
    this.bodyMat.emissive.copy(this.baseColor).multiplyScalar(0.45 * level);
  }

  dispose(): void {
    this.setVoice(null, null);
    this.root.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.halo.material.dispose(); // テクスチャは全員で共有
  }
}

function makeLabel(info: PeerInfo): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(20,20,24,0.78)';
  ctx.beginPath();
  ctx.roundRect(4, 14, 504, 100, 50);
  ctx.fill();
  ctx.fillStyle = info.color;
  ctx.beginPath();
  ctx.arc(64, 64, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 52px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const badge = info.device === 'desktop' ? 'PC' : info.device.toUpperCase();
  ctx.fillText(`${info.name}`, 108, 66, info.voice === 'off' ? 300 : 250);
  if (info.voice !== 'off') drawMic(ctx, 384, 64, info.voice === 'muted');
  ctx.font = '500 34px system-ui, sans-serif';
  ctx.fillStyle = '#c8c8d0';
  ctx.fillText(badge, 420, 66, 80);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(0.32, 0.08, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** マイクの絵 (絵文字はヘッドセットのブラウザで出ないことがあるので線で描く)。muted なら赤い斜線。 */
function drawMic(ctx: CanvasRenderingContext2D, x: number, y: number, muted: boolean): void {
  ctx.save();
  const c = muted ? '#ff6b6b' : '#7ee2a8';
  ctx.fillStyle = c;
  ctx.strokeStyle = c;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.roundRect(x - 9, y - 28, 18, 32, 9);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y - 8, 17, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y + 9);
  ctx.lineTo(x, y + 20);
  ctx.stroke();
  if (muted) {
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x - 20, y - 26);
    ctx.lineTo(x + 20, y + 20);
    ctx.stroke();
  }
  ctx.restore();
}

let sharedHalo: Texture | null = null;

/** 名札の縁を光らせるテクスチャ (白。色は SpriteMaterial.color で付ける)。 */
function haloTexture(): Texture {
  if (sharedHalo) return sharedHalo;
  // 名札と同じ縮尺 (0.32 m / 512 px) で、周りに光の余白を取る
  const canvas = document.createElement('canvas');
  canvas.width = 608;
  canvas.height = 224;
  const ctx = canvas.getContext('2d')!;
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 28;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.roundRect(52, 62, 504, 100, 50); // 名札 (makeLabel) の角丸と同じ大きさ
  ctx.stroke();
  ctx.stroke(); // 重ねて光を強める
  sharedHalo = new CanvasTexture(canvas);
  sharedHalo.colorSpace = SRGBColorSpace;
  return sharedHalo;
}

export class AvatarManager {
  readonly root = new Group();
  /** 音声に参加したときに作られる (AudioContext をユーザー操作の後に作るため)。 */
  listener: AudioListener | null = null;
  private readonly avatars = new Map<string, RemoteAvatar>();
  /** アバターより先に届いた / 作り直しても残す受信音声。 */
  private readonly streams = new Map<string, MediaStream>();
  private mySpace = '';
  private myDevice = 'desktop';

  constructor() {
    this.root.name = 'avatars';
  }

  setSelf(space: string, device: string): void {
    this.mySpace = space;
    this.myDevice = device;
    for (const a of this.avatars.values()) this.applyColocation(a);
  }

  reset(peers: PeerInfo[], poses: Record<string, AvatarPose>, selfId: string): void {
    for (const id of [...this.avatars.keys()]) this.remove(id);
    for (const p of peers) {
      if (p.id === selfId) continue;
      this.upsert(p);
      const pose = poses[p.id];
      if (pose) this.setPose(p.id, pose);
    }
  }

  upsert(info: PeerInfo): void {
    let a = this.avatars.get(info.id);
    if (a) a.setInfo(info);
    else {
      a = new RemoteAvatar(info);
      this.avatars.set(info.id, a);
      this.root.add(a.root);
      const stream = this.streams.get(info.id);
      if (stream) a.setVoice(stream, this.listener);
    }
    this.applyColocation(a);
  }

  setVoiceStream(id: string, stream: MediaStream | null): void {
    if (stream) this.streams.set(id, stream);
    else this.streams.delete(id);
    this.avatars.get(id)?.setVoice(stream, this.listener);
  }

  /** 話している相手の id と音量。 */
  *voiceLevels(): Generator<[id: string, level: number, speaking: boolean]> {
    for (const [id, a] of this.avatars) yield [id, a.level, a.speaking];
  }

  remove(id: string): void {
    const a = this.avatars.get(id);
    if (!a) return;
    this.root.remove(a.root);
    a.dispose();
    this.avatars.delete(id);
  }

  setPose(id: string, pose: AvatarPose): void {
    this.avatars.get(id)?.setPose(pose);
  }

  update(dt: number): void {
    for (const a of this.avatars.values()) a.update(dt);
  }

  private applyColocation(a: RemoteAvatar): void {
    // 自分も相手も AR で、同じ同室 ID なら実物が見えている
    a.colocated = this.mySpace !== '' && a.info.space === this.mySpace && this.myDevice === 'ar' && a.info.device === 'ar';
  }
}
