// Remote participants (head, both hands, name tag) and their voices. Poses arrive in the shared frame and are smoothed.
// XR participants with the same colocation ID (space) are visible through passthrough, so only their name tag is shown.
// Voices play from a PositionalAudio on the head (spatial audio). The name tag border and head glow while speaking.

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
import type { AvatarPose, PeerInfo, Pose } from '../../shared/protocol.ts';
import { seatEye, type AnchorSpec, type SeatSpec } from '../../shared/roomConfig.ts';
import { readPose, smoothing } from '../util/pose.ts';
import { LevelMeter } from '../voice/level.ts';

const FOLLOW_RATE = 14;
/** No attenuation up to this distance (m); someone across the table (~1.5 m) sounds natural. */
const VOICE_REF_DISTANCE = 1;
const VOICE_ROLLOFF = 1.2;
const LABEL_Y = 0.2;

/** Received audio for one participant. */
class RemoteVoice {
  readonly audio: PositionalAudio;
  readonly meter: LevelMeter;
  private readonly sink: HTMLAudioElement;
  private muted = false;

  constructor(stream: MediaStream, listener: AudioListener) {
    // In Chrome, a remote WebRTC stream is silent in Web Audio unless it is also attached to a media element.
    // The element itself stays muted.
    this.sink = new Audio();
    this.sink.muted = true;
    this.sink.srcObject = stream;
    void this.sink.play().catch(() => {});

    this.audio = new PositionalAudio(listener);
    this.audio.setMediaStreamSource(stream);
    this.audio.setDistanceModel('inverse');
    this.audio.setRefDistance(VOICE_REF_DISTANCE);
    this.audio.setRolloffFactor(VOICE_ROLLOFF);
    // Voices are loudest in front. The panner faces +Z but the avatar faces -Z, so flip it.
    this.audio.setDirectionalCone(160, 320, 0.6);
    this.audio.rotation.y = Math.PI;
    // Measure the level before the panner (i.e. before distance attenuation).
    this.meter = new LevelMeter(this.audio.source!);
  }

  /** Colocated participants are heard in person, so don't play them through the speakers (doubling / echo). */
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
  /** When true, hide the body and show only the name tag (colocated). */
  colocated = false;

  private readonly head: Tracked;
  private readonly hands: [Tracked, Tracked];
  private readonly headBody: Group;
  private readonly label: Sprite;
  /** Glow around the name tag, shown only while speaking. */
  private readonly halo: Sprite;
  private readonly bodyMat: MeshStandardMaterial;
  private readonly baseColor: Color;
  private voice: RemoteVoice | null = null;

  constructor(info: PeerInfo, seat: SeatSpec, anchor: AnchorSpec) {
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
    visor.position.set(0, 0.01, -0.085); // front (-Z)
    this.headBody.add(skull, visor);
    this.label = makeLabel(info);
    this.label.position.set(0, LABEL_Y, 0);
    this.halo = new Sprite(
      new SpriteMaterial({ map: haloTexture(), color: info.color, depthTest: false, transparent: true, opacity: 0 }),
    );
    this.halo.scale.set(0.38, 0.14, 1);
    this.halo.position.set(0, LABEL_Y, 0);
    this.halo.renderOrder = 9; // behind the name tag (10)
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

    // Until a pose arrives (e.g. their tab is in the background) show them sitting on their seat.
    this.placeAtSeat(seat, anchor);
  }

  placeAtSeat(seat: SeatSpec, anchor: AnchorSpec): void {
    this.head.set({ p: seatEye(seat, anchor), q: [0, Math.sin(seat.yaw / 2), 0, Math.cos(seat.yaw / 2)] });
  }

  /** How much they are speaking (0..1); 0 when no audio is received. */
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

  /** Attach received audio to the head; null detaches it. */
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
    this.halo.material.dispose(); // the texture is shared by everyone
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

/** Microphone icon, drawn with lines because emoji may not render in headset browsers. Red slash when muted. */
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

/** Glow texture for the name tag border (white; tinted via SpriteMaterial.color). */
function haloTexture(): Texture {
  if (sharedHalo) return sharedHalo;
  // Same scale as the name tag (0.32 m / 512 px), with margin around it for the glow.
  const canvas = document.createElement('canvas');
  canvas.width = 608;
  canvas.height = 224;
  const ctx = canvas.getContext('2d')!;
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 28;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.roundRect(52, 62, 504, 100, 50); // same rounded rect as the name tag (makeLabel)
  ctx.stroke();
  ctx.stroke(); // stroke again to strengthen the glow
  sharedHalo = new CanvasTexture(canvas);
  sharedHalo.colorSpace = SRGBColorSpace;
  return sharedHalo;
}

export class AvatarManager {
  readonly root = new Group();
  /** Created when joining voice (the AudioContext must be created after a user gesture). */
  listener: AudioListener | null = null;
  private readonly avatars = new Map<string, RemoteAvatar>();
  /** Received audio, kept when it arrives before its avatar or the avatar is rebuilt. */
  private readonly streams = new Map<string, MediaStream>();
  private mySpace = '';
  private myDevice = 'desktop';
  private seats: SeatSpec[] = [{ x: 0, z: 0.75, yaw: 0 }];
  private anchor: AnchorSpec = { kind: 'table', floorOffset: 0.72 };

  constructor() {
    this.root.name = 'avatars';
  }

  /** Seats and anchor of the current room (used to place avatars that have not sent a pose yet). */
  setRoom(seats: SeatSpec[], anchor: AnchorSpec): void {
    this.seats = seats.length ? seats : this.seats;
    this.anchor = anchor;
  }

  seatOf(index: number): SeatSpec {
    return this.seats[((index % this.seats.length) + this.seats.length) % this.seats.length];
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
      a = new RemoteAvatar(info, this.seatOf(info.seat), this.anchor);
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

  /** Id and voice level of each remote participant. */
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
    // If we are both in AR with the same colocation ID, they are physically visible.
    a.colocated = this.mySpace !== '' && a.info.space === this.mySpace && this.myDevice === 'ar' && a.info.device === 'ar';
  }
}
