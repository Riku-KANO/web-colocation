// Counts failures per key in a sliding window (used against passcode guessing).

export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max = 5, windowMs = 5 * 60 * 1000, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune();
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  private prune(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}
