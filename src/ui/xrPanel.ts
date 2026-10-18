// Wrist menu used while in XR. Headsets often lack DOM overlays, so the status and buttons
// are drawn onto a single CanvasTexture and pressed with the controller ray.

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

export interface PanelButton {
  id: string;
  label: string;
  active?: boolean;
  /** Not pressable (drawn faded and ignores presses). */
  disabled?: boolean;
}

const W = 768;
const H = 640;
/** Room for four status lines. */
const STATUS_H = 256;
const COLS = 2;
const PAD = 14;

export class XRPanel {
  readonly mesh: Mesh;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private status: string[] = [];
  private buttons: PanelButton[] = [];
  private hover: string | null = null;
  private key = '';

  constructor(width = 0.24) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(width, (width * H) / W),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.mesh.renderOrder = 20;
    this.mesh.name = 'xr-panel';
    this.mesh.userData.panel = this;
  }

  set(status: string[], buttons: PanelButton[]): void {
    this.status = status;
    this.buttons = buttons;
    this.redrawIfChanged();
  }

  setHover(uv: { x: number; y: number } | null): void {
    this.hover = uv ? this.buttonAt(uv) : null;
    this.redrawIfChanged();
  }

  /** Id of the button at the given UV (0..1, origin at bottom-left). */
  buttonAt(uv: { x: number; y: number }): string | null {
    const x = uv.x * W;
    const y = (1 - uv.y) * H;
    for (let i = 0; i < this.buttons.length; i++) {
      const r = this.rect(i);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return this.buttons[i].disabled ? null : this.buttons[i].id;
    }
    return null;
  }

  private rect(i: number) {
    const rows = Math.ceil(this.buttons.length / COLS);
    const bw = (W - PAD * (COLS + 1)) / COLS;
    const bh = (H - STATUS_H - PAD * (rows + 1)) / rows;
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    return { x: PAD + c * (bw + PAD), y: STATUS_H + PAD + r * (bh + PAD), w: bw, h: bh };
  }

  private redrawIfChanged(): void {
    const key = JSON.stringify([this.status, this.buttons, this.hover]);
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(18,22,30,0.88)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 36);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    this.status.forEach((line, i) => {
      ctx.font = i === 0 ? '700 40px system-ui, sans-serif' : '500 32px system-ui, sans-serif';
      ctx.fillStyle = i === 0 ? '#ffffff' : '#cfd6e2';
      ctx.fillText(line, 28, 22 + i * 56, W - 56);
    });

    this.buttons.forEach((b, i) => {
      const r = this.rect(i);
      ctx.fillStyle = b.disabled ? '#232a36' : b.active ? '#2f80ed' : b.id === this.hover ? '#4a5568' : '#2d3748';
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 20);
      ctx.fill();
      ctx.fillStyle = b.disabled ? '#7a8496' : '#ffffff';
      ctx.font = '600 34px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2, r.w - 16);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    });
    this.texture.needsUpdate = true;
  }
}
