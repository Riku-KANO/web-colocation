// Voice level (0..1) and "speaking" detection, used to highlight name tags and in the HUD.

import { smoothing } from '../util/pose.ts';

/** Maps -55 dBFS to 0 and -20 dBFS to 1. */
const FLOOR_DB = -55;
const RANGE_DB = 35;
const SPEAKING_LEVEL = 0.3;
/** How long the indicator lingers after speech stops (so it doesn't flicker between words). */
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
    // ~43 ms at 48 kHz: covers a whole frame interval (60-90 Hz) so short sounds aren't missed
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
    // Fast attack, slow release
    this.level += (target - this.level) * smoothing(target > this.level ? 30 : 5, dt);
    this.hold = this.level > SPEAKING_LEVEL ? HOLD_S : this.hold - dt;
    this.speaking = this.hold > 0;
    return this.level;
  }

  dispose(): void {
    this.source.disconnect(this.analyser);
  }
}
