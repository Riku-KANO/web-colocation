// The application: scene, network bridge, XR session and calibration state.

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
import type { ClientConfig } from '../shared/clientConfig.ts';
import type { AvatarPose, DeviceKind, ErrorCode, PeerInfo, Pose, RoomSnapshot, ServerMsg } from '../shared/protocol.ts';
import type { RoomConfig, SeatSpec } from '../shared/roomConfig.ts';
import { BoardManager } from './board/boardManager.ts';
import { StrokeWriter } from './board/strokeWriter.ts';
import { t, tl } from './i18n/index.ts';
import { DesktopInput } from './input/desktopInput.ts';
import { XRInput } from './input/xrInput.ts';
import { NetClient, defaultServerUrl, type ConnState } from './net/netClient.ts';
import { Environment } from './scene/environment.ts';
import { DEFAULT_MODEL_LIMITS, ModelLoader } from './scene/modelLoader.ts';
import { AvatarManager } from './sync/avatars.ts';
import { ObjectManager } from './sync/objects.ts';
import {
  SharedFrame,
  desktopFrame,
  frameFromOnePoint,
  frameFromTwoPoints,
  frameInFrontOfViewer,
} from './sync/sharedFrame.ts';
import { Hud, INKS } from './ui/hud.ts';
import type { JoinOptions } from './ui/lobby.ts';
import { openSettingsDialog } from './ui/settingsDialog.ts';
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
  readonly boards = new BoardManager(t('board.clear'));
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
  /** Configuration of the room we are in (null until `welcome`). */
  room: RoomConfig | null = null;
  readonly peers = new Map<string, PeerInfo>();
  readonly client: ClientConfig;
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

  constructor(opts: JoinOptions, client: ClientConfig) {
    this.opts = opts;
    this.client = client;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.xr.enabled = true;
    document.getElementById('app')!.appendChild(this.renderer.domElement);

    this.env = new Environment(this.scene);
    this.env.setMode('desktop');
    this.scene.add(this.frame.root);

    this.net = new NetClient(defaultServerUrl(client.allowServerOverride), {
      room: opts.room,
      name: opts.name,
      color: opts.color,
      device: 'desktop',
      space: opts.space,
      voice: 'off',
      ...storedPasscode(opts.room),
    });
    const send = this.net.send.bind(this.net);
    const sendState = this.net.sendState.bind(this.net);

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
      models: new ModelLoader({ ...DEFAULT_MODEL_LIMITS, ...client.models }),
      send: sendState,
      selfId: () => this.self?.id ?? null,
      isPeerPresent: (id) => this.peers.has(id),
      peerColor: (id) => this.peers.get(id)?.color ?? null,
    });
    this.strokes = new StrokeWriter(this.boards, sendState, () => this.self?.id ?? null);
    this.frame.root.add(this.env.table, this.boards.root, this.objects.root, this.avatars.root);

    this.desktop = new DesktopInput({
      canvas: this.renderer.domElement,
      camera: this.camera,
      sharedRoot: this.frame.root,
      objects: this.objects,
      boards: this.boards,
      strokes: this.strokes,
      inkColor: () => this.ink,
      onBoardClear: (id) => this.clearBoard(id),
    });

    this.xr = new XRInput({
      renderer: this.renderer,
      scene: this.scene,
      sharedRoot: this.frame.root,
      objects: this.objects,
      boards: this.boards,
      strokes: this.strokes,
      panel: this.panel,
      inkColor: () => this.self?.color ?? this.ink,
      inputProfilesPath: client.xr.inputProfilesPath,
      isCalibrating: () => this.calibration !== null,
      onCalibrationPoint: (p) => this.onCalibrationPoint(p),
      onPanelButton: (id) => this.onPanelButton(id),
      onBoardClear: (id) => this.clearBoard(id),
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
        resetObjects: () => this.net.sendState({ t: 'reset-objects' }),
        clearBoard: () => this.clearAllBoards(),
        setInk: (c) => (this.ink = c),
        voice: () => this.toggleVoice(),
        voiceLeave: () => this.voice.leave(),
        openSettings: () => {
          if (this.room) openSettingsDialog(this.room, this.client, (settings) => this.net.sendState({ t: 'room-settings', settings }));
        },
      },
      support,
      this.ink,
    );
    this.net.onState = (s) => this.onConnState(s);
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onFatal = (code, message) => this.onFatal(code, message);
    this.net.onAuthExpired = () => location.reload();
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

  clearBoard(boardId: string): void {
    if (!this.can('clearBoard')) return void this.hud.toast(t('error.not-allowed'));
    this.boards.clear(boardId);
    this.net.sendState({ t: 'board-clear', board: boardId });
  }

  clearAllBoards(): void {
    for (const b of this.boards.all()) this.clearBoard(b.id);
  }

  /** Whether the local user may perform an action under the room's rules. */
  can(action: keyof RoomConfig['rules']['permissions']): boolean {
    const level = this.room?.rules.permissions[action] ?? 'everyone';
    return level === 'everyone' || this.self?.role === 'host';
  }

  /** The seat spec for a seat index (wraps around if a room shrank). */
  seatOf(index: number | undefined): SeatSpec {
    const seats = this.room?.seats ?? [{ x: 0, z: 0.75, yaw: 0 }];
    const i = index ?? 0;
    return seats[((i % seats.length) + seats.length) % seats.length];
  }

  private get roomTitle(): string {
    return this.room ? tl(this.room.title, this.room.id) : this.opts.room;
  }

  /** Voice is enabled for the deployment and for this room. */
  get voiceAllowed(): boolean {
    return this.client.voiceEnabled && (this.room?.rules.voice.enabled ?? true);
  }

  private get anchor() {
    return this.room?.anchor ?? { kind: 'table' as const, floorOffset: 0.72 };
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
        this.applyRoom(m.config, m.self, m.snapshot, false);
        break;
      case 'config':
        this.applyRoom(m.config, m.self, m.snapshot, true);
        break;
      case 'ice':
        this.voice.mesh.setIceServers(m.iceServers);
        break;
      case 'peer-join':
      case 'peer-update':
        this.peers.set(m.peer.id, m.peer);
        if (m.peer.id === this.self?.id) this.self = m.peer; // e.g. promoted to host
        else this.avatars.upsert(m.peer);
        this.voice.mesh.sync(this.self?.id ?? null, this.peers.values());
        if (m.t === 'peer-join') this.hud.toast(t('toast.joined', { name: m.peer.name }));
        break;
      case 'peer-leave': {
        const p = this.peers.get(m.id);
        this.peers.delete(m.id);
        this.avatars.remove(m.id);
        this.voice.mesh.sync(this.self?.id ?? null, this.peers.values());
        this.objects.refreshHighlights();
        if (p) this.hud.toast(t('toast.left', { name: p.name }));
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
        this.boards.addStroke(m.stroke);
        break;
      case 'stroke-pts':
        this.boards.appendPoints(m.id, m.pts);
        break;
      case 'stroke-end':
        this.boards.endStroke(m.id);
        break;
      case 'board-clear':
        this.boards.clear(m.board);
        break;
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice':
        this.voice.mesh.handleSignal(m);
        break;
      case 'error':
        // Fatal errors are handled by onFatal (the client stops reconnecting).
        this.hud.toast(t(`error.${m.code}`));
        break;
      case 'pong':
        break;
    }
    if (m.t !== 'pose' && m.t !== 'move' && m.t !== 'stroke-pts' && m.t !== 'rtc-ice') this.refreshHud();
  }

  /** Build (or rebuild) the scene for a room configuration and load the snapshot. */
  private applyRoom(config: RoomConfig, self: PeerInfo, snapshot: RoomSnapshot, reconfigured: boolean): void {
    const previous = this.room;
    this.room = config;
    this.self = self;
    this.peers.clear();
    for (const p of snapshot.peers) this.peers.set(p.id, p);
    if (reconfigured) {
      // Everything in flight refers to the old layout.
      this.strokes.abortAll();
      this.desktop.cancel();
      this.xr.releaseAll();
    }
    this.env.applyConfig(config);
    if (!previous || reconfigured) this.boards.build(config.boards);
    this.boards.load(snapshot.strokes);
    this.objects.load(snapshot.objects);
    this.avatars.setRoom(config.seats, config.anchor);
    this.avatars.reset(snapshot.peers, snapshot.poses, self.id);
    this.avatars.setSelf(self.space, this.device);
    this.voice.mesh.sync(self.id, this.peers.values());
    if (!this.voiceAllowed && this.voice.state !== 'off') this.voice.leave();
    const seat = this.seatOf(self.seat);
    if (!this.renderer.xr.isPresenting) {
      this.frame.set(desktopFrame(config.anchor), 'desktop');
      this.desktop.placeCamera(seat, config.anchor);
    } else {
      this.xr.placeWorldPanel(seat, config.anchor);
      // Keep a calibration whose origin still means the same thing; otherwise place again.
      const anchorChanged = previous && previous.anchor.kind !== config.anchor.kind;
      if (reconfigured && (anchorChanged || this.frame.kind === 'auto')) this.needsAutoPlace = true;
      else if (reconfigured) this.hud.toast(t('toast.replace'));
    }
    if (reconfigured && !this.renderer.xr.isPresenting) this.hud.toast(t('toast.roomChanged'));
  }

  private onFatal(code: ErrorCode, _message?: string): void {
    if (code === 'passcode-required' || code === 'passcode-invalid') {
      if (code === 'passcode-invalid') this.hud.toast(t('error.passcode-invalid'));
      const pass = window.prompt(t('passcode.prompt', { room: this.opts.room }));
      if (pass) {
        try {
          sessionStorage.setItem(`colo.passcode.${this.opts.room}`, pass);
        } catch {
          // ignore
        }
        this.net.retryWithPasscode(pass);
      }
      return;
    }
    if (code === 'unauthenticated') {
      location.reload();
      return;
    }
    this.hud.toast(t(`error.${code}`));
  }

  private refreshHud(): void {
    if (!this.hud) return;
    this.hud.setStatus(this.roomTitle, this.net.state, this.net.rttMs);
    this.hud.setPermissions({
      clearBoard: this.can('clearBoard'),
      resetObjects: this.can('resetObjects'),
      editSettings: this.can('editSettings') && !!this.room,
      voice: this.voiceAllowed,
    });
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
      this.xr.placeWorldPanel(this.seatOf(this.self?.seat), this.anchor);
      this.xr.reattachPanel();
      this.hud.setPresenting(true);
      session.addEventListener('end', () => this.onXREnd());
    } catch (e) {
      console.error(e);
      this.hud.toast(t('toast.xrFailed', { message: (e as Error).message }));
    }
  }

  private onXREnd(): void {
    this.xr.releaseAll();
    this.calibration = null;
    this.frame.set(desktopFrame(this.anchor), 'desktop');
    this.setDevice('desktop');
    this.env.setMode('desktop');
    this.desktop.enabled = true;
    this.desktop.placeCamera(this.seatOf(this.self?.seat), this.anchor);
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
        this.net.sendState({ t: 'reset-objects' });
        break;
      case 'clear':
        this.clearAllBoards();
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
    const seat = this.seatOf(this.self?.seat);
    if (c.kind === 'one-point') {
      const headPos = new Vector3().setFromMatrixPosition(this.head);
      this.frame.set(frameFromOnePoint(p, headPos, seat, this.anchor), 'one-point', true);
      this.calibration = null;
    } else if (!c.a) {
      c.a = p.clone();
    } else {
      if (c.a.distanceTo(p) < 0.1) {
        this.hud.toast(t('toast.pointsTooClose'));
        return;
      }
      this.frame.set(frameFromTwoPoints(c.a, p), 'two-point', true);
      this.calibration = null;
    }
  }

  private panelState(): { status: string[]; buttons: PanelButton[] } {
    const conn = this.net.state === 'open' ? t('xr.people', { n: this.peers.size }) : t('xr.offline');
    const c = this.calibration;
    const hint = !c
      ? t('xr.hint.idle')
      : c.kind === 'one-point'
        ? t('xr.hint.onePoint')
        : !c.a
          ? t('xr.hint.pointA')
          : t('xr.hint.pointB');
    const v = this.voice;
    const inVoice = [...this.peers.values()].filter((p) => p.id !== this.self?.id && p.voice !== 'off').length;
    const speaking = this.speakingNames.length ? t('xr.voice.speaking', { names: this.speakingNames.join(', ') }) : '';
    const voiceLine =
      v.state === 'off'
        ? inVoice
          ? t('xr.voice.offWithPeers', { n: inVoice })
          : t('xr.voice.off')
        : (v.state === 'on' ? t('xr.voice.on') : v.hasMic ? t('xr.voice.muted') : t('xr.voice.listen')) + speaking;
    const voiceLabel = v.busy
      ? t('voice.checking')
      : v.state === 'off'
        ? t('voice.join')
        : v.state === 'on'
          ? t('voice.mute')
          : v.hasMic
            ? t('voice.unmute')
            : t('voice.useMic');
    const buttons: PanelButton[] = [
      { id: 'place', label: t('xr.btn.place'), active: c?.kind === 'one-point' },
      { id: 'colocate', label: t('xr.btn.colocate'), active: c?.kind === 'two-point' },
      { id: 'front', label: t('xr.btn.front') },
      { id: 'table', label: this.env.tableVisible ? t('xr.btn.hideTable') : t('xr.btn.showTable') },
      { id: 'reset', label: t('xr.btn.reset'), disabled: !this.can('resetObjects') },
      { id: 'clear', label: t('xr.btn.clear'), disabled: !this.can('clearBoard') },
    ];
    if (this.voiceAllowed) buttons.push({ id: 'voice', label: voiceLabel, active: v.state === 'on', disabled: v.busy });
    buttons.push({ id: 'exit', label: t('xr.btn.exit') });
    return {
      status: [
        `${this.roomTitle} · ${conn}`,
        t('xr.placement', { kind: t(`xr.kind.${this.frame.kind}`) }) + (this.frame.anchored ? ' ⚓' : ''),
        hint,
        this.voiceAllowed ? voiceLine : '',
      ],
      buttons,
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
          this.frame.set(frameInFrontOfViewer(hp, hq, this.seatOf(this.self?.seat), this.anchor), 'auto', true);
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
    this.boards.update(now);
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
      strokes: this.boards.strokeCount,
      room: this.room ? { id: this.room.id, template: this.room.template, epoch: this.net.epoch, role: this.self?.role } : null,
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

/** A passcode entered earlier in this tab, so reconnects (e.g. after a server restart) still work. */
function storedPasscode(room: string): { passcode?: string } {
  try {
    const p = sessionStorage.getItem(`colo.passcode.${room}`);
    return p ? { passcode: p } : {};
  } catch {
    return {};
  }
}
