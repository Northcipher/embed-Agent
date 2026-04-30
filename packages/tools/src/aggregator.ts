interface Emitter { emit(e: Record<string, unknown>): void; }

export class Aggregator {
  private stage = "unknown";
  private count = 0;
  private elapsed = 0;
  private markers: { text: string; stage: string }[] = [];

  constructor(private eb: Emitter, private interval = 300) {}

  setMarkers(m: { text: string; stage: string }[]): void { this.markers = m; }

  feed(line: string): void {
    this.count++;
    for (const m of this.markers) {
      if (line.includes(m.text) && this.stage !== m.stage) {
        const prev = this.stage;
        this.stage = m.stage;
        this.eb.emit({ type: "stage_transition", from: prev, to: m.stage, elapsed: this.elapsed, payload: {} });
      }
    }
  }

  onExecComplete(_sid: string): void { /* cross-source correlation */ }

  async checkpoint(): Promise<Record<string, unknown>> {
    const cp = {
      type: "checkpoint", severity: "info", stage: this.stage,
      lines_per_sec: this.interval > 0 ? Math.round(this.count / this.interval) : 0,
      output_pattern: this.count === 0 ? "silence" : "stable",
      payload: {},
    } as Record<string, unknown>;
    this.eb.emit(cp);
    this.count = 0;
    this.elapsed += this.interval;
    return cp;
  }
}
