// On-screen UI (status, participants, buttons). XR has the same actions on the wrist panel.

import type { PeerInfo, VoiceState } from '../../shared/protocol.ts';
import { t } from '../i18n/index.ts';
import type { ConnState } from '../net/netClient.ts';
import type { LinkState } from '../voice/mesh.ts';
import type { XRSupport } from '../xr/session.ts';
import { h, replaceChildren } from './dom.ts';

export const INKS = ['#222222', '#d62828', '#1d4ed8', '#15803d', '#f59e0b'];

export interface HudHandlers {
  enterAR(): void;
  enterVR(): void;
  resetObjects(): void;
  clearBoard(): void;
  setInk(color: string): void;
  /** Join voice / toggle mute. */
  voice(): void;
  voiceLeave(): void;
  openSettings(): void;
}

export interface VoiceView {
  state: VoiceState;
  busy: boolean;
  /** Joined without a microphone (listening only). */
  listenOnly: boolean;
}

export interface PermissionView {
  clearBoard: boolean;
  resetObjects: boolean;
  editSettings: boolean;
  voice: boolean;
}

export class Hud {
  private readonly el = document.getElementById('hud')!;
  private readonly status = h('div', { class: 'status' });
  private readonly peersEl = h('ul', { class: 'peers' });
  private readonly toastEl = h('div', { class: 'toast', hidden: true });
  private readonly bottom: HTMLElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly voiceWrap: HTMLElement;
  private readonly voiceBtn: HTMLButtonElement;
  private readonly voiceLeaveBtn: HTMLButtonElement;
  private toastTimer: number | undefined;
  private speakingKey = '';

  constructor(handlers: HudHandlers, support: XRSupport, ink: string) {
    const btn = (label: string, onClick: () => void, attrs: Record<string, string | boolean> = {}) =>
      h('button', { type: 'button', ...attrs, on: { click: onClick } }, label);
    this.resetBtn = btn(t('hud.reset'), () => handlers.resetObjects());
    this.clearBtn = btn(t('hud.clear'), () => handlers.clearBoard());
    this.settingsBtn = btn(t('hud.settings'), () => handlers.openSettings(), { class: 'secondary', hidden: true });
    this.voiceBtn = btn(t('voice.join'), () => handlers.voice());
    this.voiceLeaveBtn = btn(t('voice.leave'), () => handlers.voiceLeave(), { class: 'secondary', hidden: true });
    this.voiceWrap = h('span', { class: 'voice' }, this.voiceBtn, this.voiceLeaveBtn);
    const inks = INKS.map((c) =>
      h('button', {
        type: 'button',
        class: c === ink ? 'ink on' : 'ink',
        'aria-label': t('hud.ink', { color: c }),
        vars: { '--c': c },
        on: {
          click: (e) => {
            handlers.setInk(c);
            for (const b of this.el.querySelectorAll('.ink')) b.classList.toggle('on', b === e.currentTarget);
          },
        },
      }),
    );
    this.bottom = h(
      'div',
      { class: 'panel bottom' },
      h(
        'div',
        { class: 'row' },
        btn(t('hud.enterAR'), () => handlers.enterAR(), { disabled: !support.ar, title: support.ar ? '' : t('hud.arUnsupported') }),
        btn(t('hud.enterVR'), () => handlers.enterVR(), { disabled: !support.vr, title: support.vr ? '' : t('hud.vrUnsupported') }),
        this.resetBtn,
        this.clearBtn,
        this.voiceWrap,
        this.settingsBtn,
      ),
      h('div', { class: 'row inks' }, ...inks, h('span', { class: 'help' }, t('hud.help'))),
    );
    this.el.hidden = false;
    replaceChildren(this.el, h('div', { class: 'panel top' }, this.status, this.peersEl), this.bottom, this.toastEl);
  }

  setStatus(roomTitle: string, conn: ConnState, rtt: number | null): void {
    const label = conn === 'open' ? t('hud.connected') : conn === 'connecting' ? t('hud.connecting') : t('hud.disconnected');
    replaceChildren(
      this.status,
      h('span', { class: `dot ${conn}` }),
      h('b', {}, roomTitle),
      ` · ${label}${rtt !== null && conn === 'open' ? ` · ${Math.round(rtt)} ms` : ''}`,
    );
  }

  /** `link`: state of my voice connection to that person (null when not connected). */
  setPeers(peers: PeerInfo[], selfId: string | null, link: (id: string) => LinkState | null = () => null): void {
    this.speakingKey = '';
    replaceChildren(
      this.peersEl,
      ...peers.map((p) => {
        const mic = p.voice === 'on' ? ' 🎤' : p.voice === 'muted' ? ' 🔇' : '';
        const l = p.id === selfId ? null : link(p.id);
        const linkLabel = l === 'connecting' ? ` · ${t('voice.linkConnecting')}` : l === 'failed' ? ` · ${t('voice.linkFailed')}` : '';
        const device = p.device === 'desktop' ? 'PC' : p.device.toUpperCase();
        return h(
          'li',
          { 'data-id': p.id },
          h('span', { class: 'chip', vars: { '--c': p.color } }),
          p.name,
          p.verified ? ' ✓' : '',
          p.id === selfId ? ` ${t('hud.you')}` : '',
          mic,
          p.role === 'host' ? h('span', { class: 'badge' }, t('hud.host')) : null,
          h('small', {}, `${device}${p.space ? ` · ${p.space}` : ''}${linkLabel}`),
        );
      }),
    );
  }

  /** Highlight people who are speaking (touches the DOM only on change). */
  setSpeaking(ids: ReadonlySet<string>): void {
    const key = [...ids].sort().join(',');
    if (key === this.speakingKey) return;
    this.speakingKey = key;
    for (const li of this.peersEl.querySelectorAll<HTMLElement>('li[data-id]')) li.classList.toggle('speaking', ids.has(li.dataset.id!));
  }

  setPermissions(p: PermissionView): void {
    const apply = (b: HTMLButtonElement, allowed: boolean) => {
      b.disabled = !allowed;
      b.title = allowed ? '' : t('hud.hostOnly');
    };
    apply(this.resetBtn, p.resetObjects);
    apply(this.clearBtn, p.clearBoard);
    this.settingsBtn.hidden = !p.editSettings;
    this.voiceWrap.hidden = !p.voice;
  }

  setVoice(v: VoiceView): void {
    const b = this.voiceBtn;
    b.disabled = v.busy;
    b.classList.toggle('live', v.state === 'on');
    b.textContent = v.busy
      ? t('voice.checking')
      : v.state === 'off'
        ? t('voice.join')
        : v.state === 'on'
          ? t('voice.mute')
          : v.listenOnly
            ? t('voice.useMic')
            : t('voice.unmute');
    b.title = v.state === 'on' ? t('voice.micOnTitle') : '';
    this.voiceLeaveBtn.hidden = v.state === 'off';
    this.voiceLeaveBtn.disabled = v.busy;
  }

  /** Hide the bottom controls while in XR (so they do not cover the emulator view). */
  setPresenting(presenting: boolean): void {
    this.bottom.hidden = presenting;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), 3500);
  }
}
