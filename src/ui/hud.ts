// 画面上の UI (ロビー・状態表示・ボタン)。XR 中は使えないので、同等の操作は XRPanel にもある。

import type { PeerInfo, VoiceState } from '../../shared/protocol.ts';
import type { ConnState } from '../net/netClient.ts';
import type { LinkState } from '../voice/mesh.ts';
import type { XRSupport } from '../xr/session.ts';

export interface JoinOptions {
  name: string;
  room: string;
  space: string;
  color: string;
}

export const PALETTE = ['#e4572e', '#4c8bf5', '#3fb27f', '#f2a541', '#9b5de5', '#f15bb5', '#00bbf9', '#2b2d42'];
export const INKS = ['#222222', '#d62828', '#1d4ed8', '#15803d', '#f59e0b'];

const STORAGE_KEY = 'colo.profile';

function loadProfile(): Partial<JoinOptions> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<JoinOptions>;
  } catch {
    return {};
  }
}

function saveProfile(p: JoinOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // プライベートモードなどでは保存できなくてよい
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** URL パラメータ > 前回の入力 > 既定値 の順で初期値を決める。autojoin=1 ならロビーを飛ばす。 */
export function showLobby(): Promise<JoinOptions> {
  const params = new URLSearchParams(location.search);
  const saved = loadProfile();
  const initial: JoinOptions = {
    name: params.get('name') ?? saved.name ?? '',
    room: params.get('room') ?? saved.room ?? 'demo',
    space: params.get('space') ?? saved.space ?? '',
    color: params.get('color') ?? saved.color ?? '',
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(initial.color)) initial.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  if (params.get('autojoin') === '1' && initial.name) return Promise.resolve(initial);

  const root = document.getElementById('lobby')!;
  root.hidden = false;
  root.innerHTML = `
    <form class="card">
      <h1>WebXR コロケーション</h1>
      <p class="sub">同じルーム名の人と、机の上の物・ペン・ホワイトボードを共有します。</p>
      <label>名前<input name="name" maxlength="32" required value="${esc(initial.name)}" placeholder="例: 山田"></label>
      <label>ルーム<input name="room" maxlength="64" required value="${esc(initial.room)}"></label>
      <label>同室 ID <small>(任意・同じ物理空間にいる人同士で同じ文字列)</small>
        <input name="space" maxlength="64" value="${esc(initial.space)}" placeholder="例: office-3F"></label>
      <div class="swatches">${PALETTE.map(
        (c) => `<label class="swatch" style="--c:${c}"><input type="radio" name="color" value="${c}" ${c === initial.color ? 'checked' : ''}></label>`,
      ).join('')}</div>
      <button type="submit">参加する</button>
    </form>`;
  const form = root.querySelector('form')!;
  return new Promise((resolve) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const opts: JoinOptions = {
        name: String(fd.get('name') ?? '').trim(),
        room: String(fd.get('room') ?? '').trim() || 'demo',
        space: String(fd.get('space') ?? '').trim(),
        color: String(fd.get('color') ?? initial.color),
      };
      saveProfile(opts);
      root.hidden = true;
      resolve(opts);
    });
  });
}

export interface HudHandlers {
  enterAR(): void;
  enterVR(): void;
  resetObjects(): void;
  clearBoard(): void;
  setInk(color: string): void;
  /** 音声に参加 / ミュート切り替え。 */
  voice(): void;
  voiceLeave(): void;
}

export interface VoiceView {
  state: VoiceState;
  busy: boolean;
  /** 聞くだけ (マイク無し) で参加しているか。 */
  listenOnly: boolean;
}

export class Hud {
  private readonly el = document.getElementById('hud')!;
  private readonly status: HTMLElement;
  private readonly peersEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly voiceBtn: HTMLButtonElement;
  private readonly voiceLeaveBtn: HTMLButtonElement;
  private toastTimer: number | undefined;
  private speakingKey = '';

  constructor(h: HudHandlers, support: XRSupport, ink: string) {
    this.el.hidden = false;
    this.el.innerHTML = `
      <div class="panel top">
        <div class="status"></div>
        <ul class="peers"></ul>
      </div>
      <div class="panel bottom">
        <div class="row">
          <button data-act="ar" ${support.ar ? '' : 'disabled'} title="${support.ar ? '' : 'この端末/ブラウザは immersive-ar 非対応'}">AR で入る</button>
          <button data-act="vr" ${support.vr ? '' : 'disabled'}>VR で入る</button>
          <button data-act="reset">物を戻す</button>
          <button data-act="clear">ボード消去</button>
          <span class="voice">
            <button data-act="voice">音声に参加</button>
            <button data-act="voice-leave" class="secondary" hidden>音声を切る</button>
          </span>
        </div>
        <div class="row inks">${INKS.map(
          (c) => `<button class="ink ${c === ink ? 'on' : ''}" data-ink="${c}" style="--c:${c}" aria-label="インク ${c}"></button>`,
        ).join('')}<span class="help">ドラッグ: 移動 / Shift+ドラッグ: 上下 / ドラッグ中ホイール: 回転 / ボード上ドラッグ: 描く</span></div>
      </div>
      <div class="toast" hidden></div>`;
    this.status = this.el.querySelector('.status')!;
    this.peersEl = this.el.querySelector('.peers')!;
    this.toastEl = this.el.querySelector('.toast')!;
    this.voiceBtn = this.el.querySelector('[data-act="voice"]')!;
    this.voiceLeaveBtn = this.el.querySelector('[data-act="voice-leave"]')!;

    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'ar') h.enterAR();
      else if (act === 'vr') h.enterVR();
      else if (act === 'reset') h.resetObjects();
      else if (act === 'clear') h.clearBoard();
      else if (act === 'voice') h.voice();
      else if (act === 'voice-leave') h.voiceLeave();
      else if (t.dataset.ink) {
        h.setInk(t.dataset.ink);
        this.el.querySelectorAll('.ink').forEach((b) => b.classList.toggle('on', b === t));
      }
    });
  }

  setStatus(room: string, conn: ConnState, rtt: number | null): void {
    const label = conn === 'open' ? '接続中' : conn === 'connecting' ? '接続しています…' : '切断 (再接続待ち)';
    this.status.innerHTML = `<span class="dot ${conn}"></span><b>${esc(room)}</b> · ${label}${
      rtt !== null && conn === 'open' ? ` · ${Math.round(rtt)} ms` : ''
    }`;
  }

  /** link: 自分とその人の音声接続の状態 (接続していなければ null)。 */
  setPeers(peers: PeerInfo[], selfId: string | null, link: (id: string) => LinkState | null = () => null): void {
    this.speakingKey = '';
    this.peersEl.innerHTML = peers
      .map((p) => {
        const mic = p.voice === 'on' ? ' 🎤' : p.voice === 'muted' ? ' 🔇' : '';
        const l = p.id === selfId ? null : link(p.id);
        const linkLabel = l === 'connecting' ? ' · 音声接続中…' : l === 'failed' ? ' · 音声接続失敗' : '';
        return `<li data-id="${esc(p.id)}"><span class="chip" style="--c:${p.color}"></span>${esc(p.name)}${
          p.id === selfId ? ' (自分)' : ''
        }${mic}<small>${p.device === 'desktop' ? 'PC' : p.device.toUpperCase()}${p.space ? ` · ${esc(p.space)}` : ''}${linkLabel}</small></li>`;
      })
      .join('');
  }

  /** 話している人を強調する。変化したときだけ DOM を触る。 */
  setSpeaking(ids: ReadonlySet<string>): void {
    const key = [...ids].sort().join(',');
    if (key === this.speakingKey) return;
    this.speakingKey = key;
    this.peersEl.querySelectorAll<HTMLElement>('li[data-id]').forEach((li) => {
      li.classList.toggle('speaking', ids.has(li.dataset.id!));
    });
  }

  setVoice(v: VoiceView): void {
    const b = this.voiceBtn;
    b.disabled = v.busy;
    b.classList.toggle('live', v.state === 'on');
    b.textContent = v.busy
      ? 'マイクを確認中…'
      : v.state === 'off'
        ? '音声に参加'
        : v.state === 'on'
          ? 'ミュート'
          : v.listenOnly
            ? 'マイクを使う'
            : 'ミュート解除';
    b.title = v.state === 'on' ? 'マイク ON (押すとミュート)' : '';
    this.voiceLeaveBtn.hidden = v.state === 'off';
    this.voiceLeaveBtn.disabled = v.busy;
  }

  /** XR 中は画面下の操作パネルを隠す (エミュレータで XR 画面に重ならないように)。 */
  setPresenting(presenting: boolean): void {
    this.el.querySelector<HTMLElement>('.bottom')!.hidden = presenting;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), 3500);
  }
}
