// Prometheus text exposition without dependencies. Counters only grow; gauges are sampled on scrape.

type Labels = Record<string, string>;

const key = (name: string, labels?: Labels) =>
  labels && Object.keys(labels).length
    ? `${name}{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
        .join(',')}}`
    : name;

export class Metrics {
  private readonly counters = new Map<string, { name: string; help: string; values: Map<string, number> }>();
  private readonly gauges: Array<{ name: string; help: string; read: () => number }> = [];

  inc(name: string, help: string, labels?: Labels, by = 1): void {
    let c = this.counters.get(name);
    if (!c) {
      c = { name, help, values: new Map() };
      this.counters.set(name, c);
    }
    const k = key(name, labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  gauge(name: string, help: string, read: () => number): void {
    this.gauges.push({ name, help, read });
  }

  render(): string {
    const lines: string[] = [];
    for (const g of this.gauges) {
      lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name} ${g.read()}`);
    }
    for (const c of this.counters.values()) {
      lines.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
      for (const [k, v] of c.values) lines.push(`${k} ${v}`);
    }
    return lines.join('\n') + '\n';
  }
}
