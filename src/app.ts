// アプリ本体: シーン構築、ネットワークとの橋渡し、XR セッションとキャリブレーションの状態管理。

import {
  AudioListener,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { seatAt, type AvatarPose, type DeviceKind, type PeerInfo, type Pose, type ServerMsg } from '../shared/protocol.ts';
import { StrokeWriter } from './board/strokeWriter.ts';
import { Whiteboard } from './board/whiteboard.ts';
import { DesktopInput } from './input/desktopInput.ts';
import { XRInput } from './input/xrInput.ts';
import { NetClient, defaultServerUrl, type ConnState } from './net/netClient.ts';
import { Environment } from './scene/environment.ts';
import { AvatarManager } from './sync/avatars.ts';
import { ObjectManager } from './sync/objects.ts';
import {
  SharedFrame,
  desktopFrame,
  frameFromOnePoint,
  frameFromTwoPoints,
  frameInFrontOfViewer,
} from './sync/sharedFrame.ts';
import { Hud, INKS, type JoinOptions } from './ui/hud.ts';
import { XRPanel, type PanelButton } from './ui/xrPanel.ts';
import { toPose, worldToShared } from './util/pose.ts';
import { VoiceChat } from './voice/voiceChat.ts';
import { detectXRSupport, startXR, type XRMode } from './xr/session.ts';

const POSE_INTERVAL_MS = 50; // アバター姿勢の送信レート (20 Hz)
const SPEAKING_UI_INTERVAL_MS = 100; // HUD / XR パネルの「話している」表示の更新間隔

type Calibration = { kind: 'one-point' } | { kind: 'two-point'; a: Vector3 | null };

export class App {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100);
  readonly frame = new SharedFrame();
  readonly env: Environment;
  readonly objects: ObjectManager;
  readonly avatars = new AvatarManager();
  readonly board = new Whiteboard();
  readonly strokes: StrokeWriter;
  readonly panel = new XRPanel();
  readonly net: NetClient;
  readonly desktop: DesktopInput;
  readonly xr: XRInput;
  readonly voice: VoiceChat;
  /** 空間音声の聞き手 (カメラに付く)。音声に参加したときに作る。 */
  listener: AudioListener | null = null;
  hud!: Hud;

  self: PeerInfo | null = null;
  readonly peers = new Map<string, PeerInfo>();
  ink = INKS[0];
  device: DeviceKind = 'desktop';

  private readonly opts: JoinOptions;
  private readonly timer = new Timer();
  private loopErrors = 0;
  private calibration: Calibration | null = null;
  private needsAutoPlace = false;
  private lastPoseSent = 0;
  private readonly head = new Matrix4();
  private hasHead = false;
  private readonly tmpP = new Vector3();
  private readonly tmpQ = new Quaternion();
  private lastSpeakingUi = 0;
  private speakingNames: string[] = [];

  constructor(opts: JoinOptions) {
    this.opts = opts;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.xr.enabled = true;
    document.getElementById('app')!.appendChild(this.renderer.domElement);

    this.env = new Environment(this.scene);
    this.env.setMode('desktop');
    this.scene.add(this.frame.root);

    this.net = new NetClient(defaultServerUrl(), {
      room: opts.room,
      name: opts.name,
      color: opts.color,
      device: 'desktop',
      space: opts.space,
      voice: 'off',
    });
    const send = this.net.send.bind(this.net);

    this.voice = new VoiceChat({
      send,
      onRemoteStream: (id, stream) => this.avatars.setVoiceStream(id, stream),
      onLinkChange: () => this.refreshHud(),
      onStateChange: (state) => {
        this.net.updateProfile({ voice: state });
        this.refreshHud();
      },
      notify: (text) => this.hud?.toast(text),
    });

    this.objects = new ObjectManager({
      send,
      selfId: () => this.self?.id ?? null,
      isPeerPresent: (id) => this.peers.has(id),
      peerColor: (id) => this.peers.get(id)?.color ?? null,
    });
    this.strokes = new StrokeWriter(this.board, send, () => this.self?.id ?? null);
    this.frame.root.add(this.env.table, this.board.root, this.objects.root, this.avatars.root);

    this.desktop = new DesktopInput({
      canvas: this.renderer.domElement,
      camera: this.camera,
      sharedRoot: this.frame.root,
      objects: this.objects,
      board: this.board,
      strokes: this.strokes,
      inkColor: () => this.ink,
      onBoardClear: () => this.clearBoard(),
    });
    this.desktop.placeCamera(seatAt(0));

    this.xr = new XRInput({
      renderer: this.renderer,
      scene: this.scene,
      sharedRoot: this.frame.root,
      objects: this.objects,
      board: this.board,
      strokes: this.strokes,
      panel: this.panel,
      inkColor: () => this.self?.color ?? this.ink,
      isCalibrating: () => this.calibration !== null,
      onCalibrationPoint: (p) => this.onCalibrationPoint(p),
      onPanelButton: (id) => this.onPanelButton(id),
      onBoardClear: () => this.clearBoard(),
    });

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  async start(): Promise<void> {
    const support = await detectXRSupport();
    this.hud = new Hud(
      {
        enterAR: () => void this.enterXR('immersive-ar'),
        enterVR: () => void this.enterXR('immersive-vr'),
        resetObjects: () => this.net.send({ t: 'reset-objects' }),
        clearBoard: () => this.clearBoard(),
        setInk: (c) => (this.ink = c),
        voice: () => this.toggleVoice(),
        voiceLeave: () => this.voice.leave(),
      },
      support,
      this.ink,
    );
    this.net.onState = (s) => this.onConnState(s);
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.connect();
    this.renderer.setAnimationLoop((t, frame) => {
      // three.js はループ内で例外が出ると次のフレームを要求しなくなる (XR では画面が固まる) ので必ず捕まえる
      try {
        this.tick(t, frame);
      } catch (e) {
        if (this.loopErrors++ < 5) console.error('[colo] frame error', e);
      }
    });
  }

  clearBoard(): void {
    this.board.clear();
    this.net.send({ t: 'board-clear', board: this.board.id });
  }

  // ---- 音声 ----

  /** 未参加なら参加、参加中ならミュート切り替え。必ずユーザー操作 (クリック / XR パネル) から呼ぶ。 */
  toggleVoice(): void {
    if (this.voice.state !== 'off') {
      void this.voice.toggleMute();
      return;
    }
    if (!this.listener) {
      // AudioContext はユーザー操作の後でないと鳴らせないので、ここで初めて作る
      this.listener = new AudioListener();
      this.camera.add(this.listener);
      this.avatars.listener = this.listener;
    }
    void this.listener.context.resume();
    void this.voice.join(this.listener.context);
  }

  // ---- ネットワーク ----

  private onConnState(s: ConnState): void {
    if (s !== 'open') {
      // 切断中の操作はサーバーに届かないので、掴んでいる物・書きかけは手放す
      this.objects.dropAllLocal();
      this.strokes.abortAll();
      this.desktop.cancel();
      this.xr.releaseAll();
      // 再接続すると id が変わり相手も古い接続を捨てるので、音声の接続も張り直す (参加状態は保つ)
      this.voice.mesh.disconnect();
    }
    this.refreshHud();
  }

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.self = m.self;
        this.peers.clear();
        for (const p of m.snapshot.peers) this.peers.set(p.id, p);
        this.objects.load(m.snapshot.objects);
        this.board.load(m.snapshot.strokes);
        this.avatars.reset(m.snapshot.peers, m.snapshot.poses, m.self.id);
        this.avatars.setSelf(m.self.space, this.device);
        this.voice.mesh.sync(m.self.id, this.peers.values());
        if (!this.renderer.xr.isPresenting) this.desktop.placeCamera(seatAt(m.self.seat));
        else this.xr.placeWorldPanel(seatAt(m.self.seat));
        break;
      case 'peer-join':
      case 'peer-update':
        this.peers.set(m.peer.id, m.peer);
        if (m.peer.id !== this.self?.id) this.avatars.upsert(m.peer);
        this.voice.mesh.sync(this.self?.id ?? null, this.peers.values());
        if (m.t === 'peer-join') this.hud.toast(`${m.peer.name} さんが参加しました`);
        break;
      case 'peer-leave': {
        const p = this.peers.get(m.id);
        this.peers.delete(m.id);
        this.avatars.remove(m.id);
        this.voice.mesh.sync(this.self?.id ?? null, this.peers.values());
        this.objects.refreshHighlights();
        if (p) this.hud.toast(`${p.name} さんが退出しました`);
        break;
      }
      case 'pose':
        this.avatars.setPose(m.id, m.pose);
        break;
      case 'owner':
        this.objects.onOwner(m.id, m.owner, m.pose);
        break;
      case 'move':
        this.objects.onMove(m.id, m.pose);
        break;
      case 'grab-denied':
        this.objects.onGrabDenied(m.id, m.owner, m.pose);
        break;
      case 'objects':
        this.objects.load(m.objects);
        break;
      case 'stroke':
        this.board.addStroke(m.stroke);
        break;
      case 'stroke-pts':
        this.board.appendPoints(m.id, m.pts);
        break;
      case 'stroke-end':
        this.board.endStroke(m.id);
        break;
      case 'board-clear':
        if (m.board === this.board.id) this.board.clear();
        break;
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice':
        this.voice.mesh.handleSignal(m);
        break;
      case 'error':
        this.hud.toast(m.message);
        break;
      case 'pong':
        break;
    }
    if (m.t !== 'pose' && m.t !== 'move' && m.t !== 'stroke-pts' && m.t !== 'rtc-ice') this.refreshHud();
  }

  private refreshHud(): void {
    if (!this.hud) return;
    this.hud.setStatus(this.opts.room, this.net.state, this.net.rttMs);
    this.hud.setPeers([...this.peers.values()], this.self?.id ?? null, (id) => this.voice.mesh.linkState(id));
    this.hud.setVoice({ state: this.voice.state, busy: this.voice.busy, listenOnly: !this.voice.hasMic });
  }

  /** 話している人 (自分を含む) を HUD と XR パネルに出す。 */
  private updateSpeaking(now: number): void {
    if (now - this.lastSpeakingUi < SPEAKING_UI_INTERVAL_MS) return;
    this.lastSpeakingUi = now;
    const ids = new Set<string>();
    for (const [id, , speaking] of this.avatars.voiceLevels()) if (speaking) ids.add(id);
    if (this.self && this.voice.localSpeaking) ids.add(this.self.id);
    this.hud.setSpeaking(ids);
    this.speakingNames = [...ids].map((id) => this.peers.get(id)?.name ?? '?');
  }

  // ---- XR セッション ----

  private async enterXR(mode: XRMode): Promise<void> {
    try {
      const session = await startXR(this.renderer, mode);
      this.setDevice(mode === 'immersive-ar' ? 'ar' : 'vr');
      this.env.setMode(this.device);
      this.desktop.enabled = false;
      this.needsAutoPlace = true;
      this.xr.placeWorldPanel(seatAt(this.self?.seat ?? 0));
      this.xr.reattachPanel();
      this.hud.setPresenting(true);
      session.addEventListener('end', () => this.onXREnd());
    } catch (e) {
      console.error(e);
      this.hud.toast(`XR を開始できませんでした: ${(e as Error).message}`);
    }
  }

  private onXREnd(): void {
    this.xr.releaseAll();
    this.calibration = null;
    this.frame.set(desktopFrame(), 'desktop');
    this.setDevice('desktop');
    this.env.setMode('desktop');
    this.desktop.enabled = true;
    this.desktop.placeCamera(seatAt(this.self?.seat ?? 0));
    this.hasHead = false;
    this.hud.setPresenting(false);
  }

  private setDevice(d: DeviceKind): void {
    this.device = d;
    this.net.updateProfile({ device: d });
    this.avatars.setSelf(this.opts.space, d);
  }

  // ---- キャリブレーション ----

  private onPanelButton(id: string): void {
    switch (id) {
      case 'place':
        this.calibration = this.calibration?.kind === 'one-point' ? null : { kind: 'one-point' };
        break;
      case 'colocate':
        this.calibration = this.calibration?.kind === 'two-point' ? null : { kind: 'two-point', a: null };
        break;
      case 'front':
        this.calibration = null;
        this.needsAutoPlace = true;
        break;
      case 'reset':
        this.net.send({ t: 'reset-objects' });
        break;
      case 'clear':
        this.clearBoard();
        break;
      case 'table':
        this.env.setTableVisible(!this.env.tableVisible);
        break;
      case 'voice':
        this.toggleVoice();
        break;
      case 'exit':
        void this.renderer.xr.getSession()?.end();
        break;
    }
  }

  private onCalibrationPoint(p: Vector3): void {
    const c = this.calibration;
    if (!c) return;
    const seat = seatAt(this.self?.seat ?? 0);
    if (c.kind === 'one-point') {
      const headPos = new Vector3().setFromMatrixPosition(this.head);
      this.frame.set(frameFromOnePoint(p, headPos, seat), 'one-point', true);
      this.calibration = null;
    } else if (!c.a) {
      c.a = p.clone();
    } else {
      if (c.a.distanceTo(p) < 0.1) {
        this.hud.toast('2 点が近すぎます (10cm 以上離してください)');
        return;
      }
      this.frame.set(frameFromTwoPoints(c.a, p), 'two-point', true);
      this.calibration = null;
    }
  }

  private panelState(): { status: string[]; buttons: PanelButton[] } {
    const n = this.peers.size;
    const conn = this.net.state === 'open' ? `${n}人` : '切断中';
    const kindLabel = {
      desktop: '-',
      auto: '仮置き (正面)',
      'one-point': '1点 (自分の机)',
      'two-point': '同室 2点',
    }[this.frame.kind];
    const c = this.calibration;
    const hint = !c
      ? '物はトリガー/ピンチで掴む。ペン先をボードへ'
      : c.kind === 'one-point'
        ? '机の中心に先端を当ててトリガー'
        : !c.a
          ? '点A (1/2) をタッチしてトリガー'
          : '点B (2/2) をタッチしてトリガー';
    const v = this.voice;
    const inVoice = [...this.peers.values()].filter((p) => p.id !== this.self?.id && p.voice !== 'off').length;
    const voiceLine =
      v.state === 'off'
        ? `音声: 未参加${inVoice ? ` (${inVoice}人が通話中)` : ''}`
        : `音声: ${v.state === 'on' ? 'マイク ON' : v.hasMic ? 'ミュート中' : '聞くだけ'}${
            this.speakingNames.length ? ` · 話し中: ${this.speakingNames.join(', ')}` : ''
          }`;
    const voiceLabel = v.busy
      ? 'マイク確認中…'
      : v.state === 'off'
        ? '音声に参加'
        : v.state === 'on'
          ? 'ミュート'
          : v.hasMic
            ? 'ミュート解除'
            : 'マイクを使う';
    return {
      status: [`${this.opts.room} · ${conn}`, `配置: ${kindLabel}${this.frame.anchored ? ' ⚓' : ''}`, hint, voiceLine],
      buttons: [
        { id: 'place', label: 'ここに机 (1点)', active: c?.kind === 'one-point' },
        { id: 'colocate', label: '同室合わせ (2点)', active: c?.kind === 'two-point' },
        { id: 'front', label: '正面に置く' },
        { id: 'table', label: this.env.tableVisible ? '机を隠す' : '机を表示' },
        { id: 'reset', label: '物を戻す' },
        { id: 'clear', label: 'ボード消去' },
        { id: 'voice', label: voiceLabel, active: v.state === 'on', disabled: v.busy },
        { id: 'exit', label: 'XR を終了' },
      ],
    };
  }

  // ---- 毎フレーム ----

  private tick(time: number, xrFrame?: XRFrame): void {
    const now = performance.now();
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const presenting = this.renderer.xr.isPresenting;

    if (presenting && xrFrame) {
      const ref = this.renderer.xr.getReferenceSpace();
      const vp = ref ? xrFrame.getViewerPose(ref) : undefined;
      if (vp) {
        this.head.fromArray(vp.transform.matrix);
        this.hasHead = true;
        if (this.needsAutoPlace) {
          this.needsAutoPlace = false;
          const hp = new Vector3();
          const hq = new Quaternion();
          this.head.decompose(hp, hq, new Vector3());
          this.frame.set(frameInFrontOfViewer(hp, hq, seatAt(this.self?.seat ?? 0)), 'auto', true);
        }
      }
      this.frame.update(xrFrame, ref);
      this.xr.update();
      const ps = this.panelState();
      this.panel.set(ps.status, ps.buttons);
    } else {
      this.desktop.update();
    }

    this.objects.update(dt, now);
    this.avatars.update(dt);
    this.voice.update(dt);
    this.updateSpeaking(now);
    this.strokes.update(now);
    this.board.update(now);
    this.sendPose(now, presenting);
    this.renderer.render(this.scene, this.camera);
  }

  private sendPose(now: number, presenting: boolean): void {
    if (now - this.lastPoseSent < POSE_INTERVAL_MS || this.net.state !== 'open' || !this.self) return;
    this.lastPoseSent = now;
    const root = this.frame.root;
    root.updateMatrixWorld(true);
    let head: Pose;
    const hands: AvatarPose['hands'] = [null, null];
    if (presenting) {
      if (!this.hasHead) return;
      worldToShared(this.head, root, this.tmpP, this.tmpQ);
      head = toPose(this.tmpP, this.tmpQ);
      (['left', 'right'] as const).forEach((side, i) => {
        const m = this.xr.handMatrix(side);
        if (!m) return;
        worldToShared(m, root, this.tmpP, this.tmpQ);
        hands[i] = toPose(this.tmpP, this.tmpQ);
      });
    } else {
      this.camera.updateMatrixWorld();
      worldToShared(this.camera.matrixWorld, root, this.tmpP, this.tmpQ);
      head = toPose(this.tmpP, this.tmpQ);
      if (this.desktop.cursorActive) hands[1] = toPose(this.desktop.cursor, this.tmpQ.identity());
    }
    this.net.send({ t: 'pose', pose: { head, hands } });
  }

  /** 自動テスト・デバッグ用に状態を要約する。 */
  debugState() {
    return {
      self: this.self,
      conn: this.net.state,
      peers: [...this.peers.values()].map((p) => p.name),
      frame: this.frame.kind,
      anchored: this.frame.anchored,
      device: this.device,
      objects: [...this.objects.all()].map((o) => ({
        id: o.id,
        owner: o.owner,
        held: o.localHold,
        p: o.root.position.toArray().map((x) => Math.round(x * 1000) / 1000),
      })),
      strokes: this.board.strokeCount,
      voice: {
        state: this.voice.state,
        mic: this.voice.hasMic,
        audio: this.listener?.context.state ?? null,
        links: this.voice.mesh.summary(),
        levels: Object.fromEntries(
          [...this.avatars.voiceLevels()].map(([id, level]) => [this.peers.get(id)?.name ?? id, Math.round(level * 100) / 100]),
        ),
      },
    };
  }
}
