/**
 * Aggregator v2 — raw time-series data collector only.
 *
 * Changes from v1:
 *   - Removed detectPattern() — no more human-classified output patterns (burst/oscillation/etc.)
 *   - checkpoint() outputs raw window_samples, stage_transitions, cross_source_events
 *   - Model observes raw data and identifies patterns itself (Bitter Lesson)
 */
interface Emitter { emit(e: Record<string, unknown>): void; }

export class Aggregator {
  private stage = "unknown";
  private count = 0;
  private elapsed = 0;
  private markers: { text: string; stage: string }[] = [];
  private stageOrder: string[] = [];
  // Time-series data for model analysis
  private windowSamples: number[] = [];
  private execResults: { stepId: string; exitCode: number; source: string; atSec: number }[] = [];
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
    // Stage transition detection (this is structural, not pattern classification)
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

  /** Cross-source correlation: record raw completion data for model analysis. */
  onExecComplete(stepId: string, exitCode?: number, source?: string): void {
    this.execResults.push({
      stepId,
      exitCode: exitCode ?? -1,
      source: source ?? "unknown",
      atSec: this.elapsed + this.interval,
    });

    // Emit correlated signal for cross-source events (structural, not semantic)
    if (this.execResults.length >= 2) {
      const last = this.execResults[this.execResults.length - 1]!;
      const prev = this.execResults[this.execResults.length - 2]!;
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

  /** Periodic checkpoint — raw time-series data, no classification. */
  async checkpoint(): Promise<Record<string, unknown>> {
    // Record this window's line count as a raw sample
    this.windowSamples.push(this.count);
    if (this.windowSamples.length > 20) this.windowSamples.shift();

    // Build stage transitions for this window — from→to pairs with timestamps
    const transitions: { from: string; to: string; at_sec: number }[] = [];
    for (let i = 1; i < this.stageOrder.length; i++) {
      transitions.push({ from: this.stageOrder[i - 1]!, to: this.stageOrder[i]!, at_sec: this.elapsed });
    }

    // Build cross-source events with timestamps
    const crossSourceEvents = this.execResults.slice(-5).map(r => ({
      source: r.source,
      exit: r.exitCode,
      at_sec: r.atSec,
    }));

    const cp = {
      type: "checkpoint", severity: "info", source: "aggregator",
      summary: `Stage: ${this.stage}, samples=[${this.windowSamples.join(",")}]`,
      payload: {
        stage: this.stage,
        lines_per_sec: this.interval > 0 ? Math.round(this.count / this.interval) : 0,
        window_samples: [...this.windowSamples],
        stage_transitions: transitions.length > 0 ? transitions : undefined,
        cross_source_events: crossSourceEvents.length > 0 ? crossSourceEvents : undefined,
        total_elapsed: this.elapsed + this.interval,
      },
    };
    this.emit(cp);

    this.count = 0;
    this.elapsed += this.interval;
    return cp;
  }

  /** Finalize aggregation at run end — emit summary. */
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
