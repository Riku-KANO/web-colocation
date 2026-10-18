// Voice call participation (off / muted / on) and the mic. Peer links are handled by VoiceMesh.
// Browsers require a user gesture for mic permission and resuming the AudioContext,
// so join() / toggleMute() are called from a HUD button or an XR panel button.

import type { VoiceState } from '../../shared/protocol.ts';
import { t } from '../i18n/index.ts';
import { LevelMeter } from './level.ts';
import { VoiceMesh, type VoiceMeshDeps } from './mesh.ts';

export interface VoiceChatDeps extends Omit<VoiceMeshDeps, 'iceServers' | 'createPeerConnection'> {
  /** Our participation state changed (tell the server, refresh the UI). */
  onStateChange(state: VoiceState): void;
  /** User-facing notification (toast). */
  notify(text: string): void;
}

interface Mic {
  track: MediaStreamTrack;
  release(): void;
}

export class VoiceChat {
  readonly mesh: VoiceMesh;
  state: VoiceState = 'off';
  /** E.g. waiting for mic permission; buttons are ignored meanwhile. */
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

  /** Our own voice level (0..1) and whether we are speaking. */
  get localLevel(): number {
    return this.state === 'on' ? (this.meter?.level ?? 0) : 0;
  }

  get localSpeaking(): boolean {
    return this.state === 'on' && (this.meter?.speaking ?? false);
  }

  /** Join the call. Without a usable mic, join listen-only (muted). */
  async join(ctx: AudioContext): Promise<void> {
    if (this.state !== 'off' || this.busy) return;
    this.ctx = ctx;
    this.setBusy(true);
    const mic = await this.acquireMic(t('voice.fallbackListen'));
    this.setBusy(false);
    this.setMic(mic);
    // Announce the join before connecting, so peers see the voice update first
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
      // Joined listen-only: try to get the mic again
      this.setBusy(true);
      const mic = await this.acquireMic(t('voice.fallbackMuted'));
      this.setBusy(false);
      if (!mic) return;
      this.setMic(mic);
    }
    this.mic!.track.enabled = true;
    this.setState('on');
  }

  /** Called every frame (drives the level meter). */
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
      // Unplugged, or permission was revoked
      if (this.mic !== mic) return;
      this.setMic(null);
      if (this.state === 'on') this.setState('muted');
      this.deps.notify(t('voice.micLost'));
    });
  }

  private async acquireMic(fallback: string): Promise<Mic | null> {
    if (new URLSearchParams(location.search).get('fakemic') === '1' && this.ctx) return this.fakeMic(this.ctx);
    if (!navigator.mediaDevices?.getUserMedia) {
      this.deps.notify(t('voice.needsHttps', { fallback }));
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
          ? t('voice.denied')
          : name === 'NotFoundError'
            ? t('voice.notFound')
            : t('voice.unavailable', { name });
      this.deps.notify(t('voice.reason', { reason, fallback }));
      return null;
    }
  }

  /** `?fakemic=1`: send a tone that pulses on a 2 s cycle instead of the mic (no-mic machines, automated tests). */
  private fakeMic(ctx: AudioContext): Mic {
    const osc = ctx.createOscillator();
    osc.frequency.value = 330;
    const gate = ctx.createGain();
    gate.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 0.5;
    const depth = ctx.createGain();
    depth.gain.value = 0.05; // gain toggles between 0 and 0.1, so the tone starts and stops
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
