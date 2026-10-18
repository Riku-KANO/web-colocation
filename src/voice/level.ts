// 音声の大きさ (0..1) と「話している」判定。名札の強調や HUD の表示に使う。

import { smoothing } from '../util/pose.ts';

/** -55 dBFS を 0、-20 dBFS を 1 にする。 */
const FLOOR_DB = -55;
const RANGE_DB = 35;
const SPEAKING_LEVEL = 0.3;
/** 話し終わってから表示を消すまで (言葉の切れ目でちらつかないように)。 */
const HOLD_S = 0.35;

export class LevelMeter {
  level = 0;
  speaking = false;
  private readonly source: AudioNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private hold = 0;

  constructor(source: AudioNode) {
    this.source = source;
    this.analyser = source.context.createAnalyser();
    // 約 43 ms (48 kHz)。1 フレーム (60〜90 Hz) の間隔をまるごと覆う長さにして、短い音も取りこぼさない
    this.analyser.fftSize = 2048;
    this.buf = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);
  }

  update(dt: number): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const x of this.buf) sum += x * x;
    const db = 10 * Math.log10(sum / this.buf.length + 1e-12);
    const target = Math.min(Math.max((db - FLOOR_DB) / RANGE_DB, 0), 1);
    // 立ち上がりは速く、減衰はゆっくり
    this.level += (target - this.level) * smoothing(target > this.level ? 30 : 5, dt);
    this.hold = this.level > SPEAKING_LEVEL ? HOLD_S : this.hold - dt;
    this.speaking = this.hold > 0;
    return this.level;
  }

  dispose(): void {
    this.source.disconnect(this.analyser);
  }
}
