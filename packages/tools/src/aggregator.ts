interface Emitter { emit(e: Record<string, unknown>): void; }

interface Baseline {
  avg_lines_per_sec: number;
  avg_silence_count: number;
  typical_stage_order: string[];
}

export class Aggregator {
  private stage = "unknown";
  private count = 0;
  private elapsed = 0;
  private markers: { text: string; stage: string }[] = [];
  // Pattern detection state
  private recentCounts: number[] = []; // last N checkpoint line counts
  private prevCount = 0;
  private stageOrder: string[] = [];
  // Cross-source state
  private execResults: { stepId: string; exitCode: number; source: string }[] = [];
  private baseline: Baseline | null = null;

  constructor(private eb: Emitter, private interval = 300) {}

  setMarkers(m: { text: string; stage: string }[]): void { this.markers = m; }

  /** Set baseline from a previous run for comparison. */
  setBaseline(b: Baseline | null): void { this.baseline = b; }

  feed(line: string): void {
    this.count++;
    // Stage transition detection
    for (const m of this.markers) {
      if (line.includes(m.text) && this.stage !== m.stage) {
        const prev = this.stage;
        this.stage = m.stage;
        this.stageOrder.push(m.stage);
        this.eb.emit({
          type: "stage_transition", source: "aggregator",
          summary: `Stage: ${prev} → ${m.stage}`,
          payload: { from: prev, to: m.stage, elapsed: this.elapsed },
        });
      }
    }
  }

  /** Cross-source correlation: compare this source's result with previous sources. */
  onExecComplete(stepId: string, exitCode?: number, source?: string): void {
    this.execResults.push({ stepId, exitCode: exitCode ?? -1, source: source ?? "unknown" });

    // Correlate: if multiple sources completed, check for temporal alignment
    if (this.execResults.length >= 2) {
      const last = this.execResults[this.execResults.length - 1]!;
      const prev = this.execResults[this.execResults.length - 2]!;
      // Different sources finishing near same time with different exit codes → correlation signal
      if (last.source !== prev.source) {
        this.eb.emit({
          type: "correlated", source: "aggregator",
          summary: `Cross-source: ${prev.source}(${prev.exitCode}) + ${last.source}(${last.exitCode})`,
          payload: {
            sources: [prev.source, last.source],
            exit_codes: [prev.exitCode, last.exitCode],
            step_ids: [prev.stepId, last.stepId],
          },
        });
      }
    }
  }

  /** Periodic checkpoint with pattern detection and baseline comparison. */
  async checkpoint(): Promise<Record<string, unknown>> {
    const linesPerSec = this.interval > 0 ? Math.round(this.count / this.interval) : 0;

    // Output pattern detection
    this.recentCounts.push(this.count);
    if (this.recentCounts.length > 10) this.recentCounts.shift();
    const pattern = this.detectPattern();

    const cp = {
      type: "checkpoint", severity: "info", source: "aggregator",
      summary: `Stage: ${this.stage}, ${linesPerSec} l/s, pattern: ${pattern}`,
      payload: {
        stage: this.stage,
        lines_per_sec: linesPerSec,
        output_pattern: pattern,
        total_elapsed: this.elapsed + this.interval,
        stage_order: [...this.stageOrder],
      },
    };
    this.eb.emit(cp);

    // Baseline comparison
    if (this.baseline) {
      const deviation = this.baseline.avg_lines_per_sec > 0
        ? Math.abs(linesPerSec - this.baseline.avg_lines_per_sec) / this.baseline.avg_lines_per_sec
        : 0;
      if (deviation > 0.5) {
        this.eb.emit({
          type: "baseline_diff", source: "aggregator", severity: "warning",
          summary: `Lines/sec deviation: ${Math.round(deviation * 100)}% from baseline (${this.baseline.avg_lines_per_sec})`,
          payload: {
            current: linesPerSec, baseline: this.baseline.avg_lines_per_sec, deviation_pct: Math.round(deviation * 100),
          },
        });
      }
      // Stage order drift
      if (this.stageOrder.length > 0 && this.baseline.typical_stage_order.length > 0) {
        const match = this.stageOrder.every((s, i) => s === this.baseline!.typical_stage_order[i]);
        if (!match && this.stageOrder.length >= this.baseline.typical_stage_order.length) {
          this.eb.emit({
            type: "baseline_diff", source: "aggregator", severity: "warning",
            summary: "Stage order diverges from baseline",
            payload: { current_order: this.stageOrder, baseline_order: this.baseline.typical_stage_order },
          });
        }
      }
    }

    this.prevCount = this.count;
    this.count = 0;
    this.elapsed += this.interval;
    return cp;
  }

  private detectPattern(): string {
    if (this.recentCounts.length < 2) return this.count === 0 ? "silence" : "unknown";
    if (this.count === 0) return "silence";

    // Check for burst: count > 2x previous
    if (this.prevCount > 0 && this.count > this.prevCount * 2) return "burst";

    // Check for oscillation: alternating high/low over last N
    if (this.recentCounts.length >= 4) {
      let oscillations = 0;
      for (let i = 2; i < this.recentCounts.length; i++) {
        const a = this.recentCounts[i - 2]!;
        const b = this.recentCounts[i - 1]!;
        const c = this.recentCounts[i]!;
        if ((b > a && b > c) || (b < a && b < c)) oscillations++;
      }
      if (oscillations >= 2) return "oscillation";
    }

    // Check for sharp decline
    if (this.prevCount > 0 && this.count < this.prevCount * 0.3) return "declining";

    return "stable";
  }

  /** Finalize aggregation at run end — emit summary and close stage tracking. */
  onRunEnd(): void {
    this.eb.emit({
      type: "observation", source: "aggregator",
      summary: `Run ended after ${this.elapsed}s in stage "${this.stage}"`,
      payload: { final_stage: this.stage, total_elapsed: this.elapsed, stage_order: this.stageOrder },
    });
  }

  getStage(): string { return this.stage; }
  getElapsed(): number { return this.elapsed; }
  getStageOrder(): string[] { return [...this.stageOrder]; }
}
