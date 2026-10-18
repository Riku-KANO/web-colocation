// 音声通話の参加状態 (off / muted / on) とマイク。相手との接続は VoiceMesh が受け持つ。
// マイクの許可と AudioContext の再開はブラウザの制約上ユーザー操作が必要なので、
// join() / toggleMute() は HUD のボタンか XR パネルのボタンから呼ぶ。

import type { VoiceState } from '../../shared/protocol.ts';
import { LevelMeter } from './level.ts';
import { VoiceMesh, type VoiceMeshDeps } from './mesh.ts';

export interface VoiceChatDeps extends Omit<VoiceMeshDeps, 'iceServers' | 'createPeerConnection'> {
  /** 自分の参加状態が変わった (サーバーへ知らせる・表示を更新する)。 */
  onStateChange(state: VoiceState): void;
  /** 利用者への通知 (トースト)。 */
  notify(text: string): void;
}

interface Mic {
  track: MediaStreamTrack;
  release(): void;
}

export class VoiceChat {
  readonly mesh: VoiceMesh;
  state: VoiceState = 'off';
  /** マイクの許可待ちなど。この間はボタンを受け付けない。 */
  busy = false;

  private readonly deps: VoiceChatDeps;
  private ctx: AudioContext | null = null;
  private mic: Mic | null = null;
  private meter: LevelMeter | null = null;

  constructor(deps: VoiceChatDeps) {
    this.deps = deps;
    // ICE servers (STUN + short-lived TURN credentials) arrive from the server after joining.
    this.mesh = new VoiceMesh({ ...deps });
  }

  get hasMic(): boolean {
    return this.mic !== null;
  }

  /** 自分の声の大きさ (0..1) と、話しているか。 */
  get localLevel(): number {
    return this.state === 'on' ? (this.meter?.level ?? 0) : 0;
  }

  get localSpeaking(): boolean {
    return this.state === 'on' && (this.meter?.speaking ?? false);
  }

  /** 通話に参加する。マイクが使えなければ聞くだけ (muted) で参加する。 */
  async join(ctx: AudioContext): Promise<void> {
    if (this.state !== 'off' || this.busy) return;
    this.ctx = ctx;
    this.setBusy(true);
    const mic = await this.acquireMic('聞くだけで参加します');
    this.setBusy(false);
    this.setMic(mic);
    // サーバーに参加を知らせてから接続を張る (相手は voice の更新を先に受け取る)
    this.setState(mic ? 'on' : 'muted');
    this.mesh.setActive(true);
  }

  leave(): void {
    if (this.state === 'off' || this.busy) return;
    this.mesh.setActive(false);
    this.setMic(null);
    this.setState('off');
  }

  async toggleMute(): Promise<void> {
    if (this.state === 'off' || this.busy) return;
    if (this.state === 'on') {
      if (this.mic) this.mic.track.enabled = false;
      this.setState('muted');
      return;
    }
    if (!this.mic) {
      // 聞くだけで参加していた: もう一度マイクを取りに行く
      this.setBusy(true);
      const mic = await this.acquireMic('ミュートのままにします');
      this.setBusy(false);
      if (!mic) return;
      this.setMic(mic);
    }
    this.mic!.track.enabled = true;
    this.setState('on');
  }

  /** 毎フレーム (音量表示用)。 */
  update(dt: number): void {
    this.meter?.update(dt);
  }

  private setState(s: VoiceState): void {
    if (s === this.state) return;
    this.state = s;
    this.deps.onStateChange(s);
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.deps.onLinkChange?.();
  }

  private setMic(mic: Mic | null): void {
    if (this.mic === mic) return;
    this.meter?.dispose();
    this.meter = null;
    this.mic?.release();
    this.mic = mic;
    this.mesh.setLocalTrack(mic?.track ?? null);
    if (!mic) return;
    if (this.ctx) this.meter = new LevelMeter(this.ctx.createMediaStreamSource(new MediaStream([mic.track])));
    mic.track.addEventListener('ended', () => {
      // 抜かれた・権限を取り消された
      if (this.mic !== mic) return;
      this.setMic(null);
      if (this.state === 'on') this.setState('muted');
      this.deps.notify('マイクが使えなくなりました (ミュートにしました)');
    });
  }

  private async acquireMic(fallback: string): Promise<Mic | null> {
    if (new URLSearchParams(location.search).get('fakemic') === '1' && this.ctx) return this.fakeMic(this.ctx);
    if (!navigator.mediaDevices?.getUserMedia) {
      this.deps.notify(`マイクは HTTPS (または localhost) のページでしか使えません。${fallback}`);
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      return track ? { track, release: () => track.stop() } : null;
    } catch (e) {
      const name = (e as DOMException).name;
      const reason =
        name === 'NotAllowedError'
          ? 'マイクの使用が許可されませんでした'
          : name === 'NotFoundError'
            ? 'マイクが見つかりません'
            : `マイクを使えません (${name})`;
      this.deps.notify(`${reason}。${fallback}`);
      return null;
    }
  }

  /** `?fakemic=1`: マイクの代わりに 2 秒周期で鳴る発振音を送る (マイクの無い環境・自動テスト用)。 */
  private fakeMic(ctx: AudioContext): Mic {
    const osc = ctx.createOscillator();
    osc.frequency.value = 330;
    const gate = ctx.createGain();
    gate.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 0.5;
    const depth = ctx.createGain();
    depth.gain.value = 0.05; // 0〜0.1 の間で鳴ったり止んだりする
    lfo.connect(depth).connect(gate.gain);
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gate).connect(dest);
    osc.start();
    lfo.start();
    const track = dest.stream.getAudioTracks()[0];
    return {
      track,
      release: () => {
        track.stop();
        osc.stop();
        lfo.stop();
        gate.disconnect();
      },
    };
  }
}
