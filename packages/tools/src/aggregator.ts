interface Emitter { emit(e: Record<string, unknown>): void; }

export class Aggregator {
  private stage = "unknown";
  private count = 0;
  private elapsed = 0;
  private markers: { text: string; stage: string }[] = [];
  // Pattern detection state
  private recentCounts: number[] = [];
  private prevCount = 0;
  private stageOrder: string[] = [];
  // Cross-source state
  private execResults: { stepId: string; exitCode: number; source: string }[] = [];
  private runId?: string;

  constructor(private eb: Emitter, private interval = 300) {}

  setRunId(runId: string): void { this.runId = runId; }

  private emit(e: Record<string, unknown>): void {
    if (this.runId) e.run_id = this.runId;
    this.eb.emit(e);
  }

  setMarkers(m: { text: string; stage: string }[]): void { this.markers = m; }

  feed(line: string): void {
    this.count++;
    // Stage transition detection
    for (const m of this.markers) {
      if (line.includes(m.text) && this.stage !== m.stage) {
        const prev = this.stage;
        this.stage = m.stage;
        this.stageOrder.push(m.stage);
        this.emit({
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
        this.emit({
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

  /** Periodic checkpoint with pattern detection. */
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
    this.emit(cp);

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
    this.emit({
      type: "observation", source: "aggregator",
      summary: `Run ended after ${this.elapsed}s in stage "${this.stage}"`,
      payload: { final_stage: this.stage, total_elapsed: this.elapsed, stage_order: this.stageOrder },
    });
  }

  getStage(): string { return this.stage; }
  getElapsed(): number { return this.elapsed; }
  getStageOrder(): string[] { return [...this.stageOrder]; }
}
