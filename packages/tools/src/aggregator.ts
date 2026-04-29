export interface AggregatorOutput {
  emit(event: Record<string, unknown>): void;
}

export class Aggregator {
  private currentStage = "unknown";
  private lineCount = 0;
  private metrics: Map<string, number> = new Map();
  private ruleHitCounts: Map<string, number> = new Map();
  private bootMarkers: { text: string; stage: string }[] = [];
  private elapsed = 0;
  private readonly intervalSec: number;

  constructor(
    private stepId: string,
    private eventBus: AggregatorOutput,
    intervalSec = 300,
  ) {
    this.intervalSec = intervalSec;
  }

  setBootMarkers(markers: { text: string; stage: string }[]): void {
    this.bootMarkers = markers;
  }

  feed(line: string): void {
    this.lineCount++;
    this.detectStage(line);
  }

  onExecComplete(_stepId: string): void {
    // Cross-source correlation happens here when multiple sources exist
    // P0: emit basic completion event
  }

  async checkpoint(): Promise<Record<string, unknown>> {
    const checkpoint = {
      type: "checkpoint",
      severity: "info",
      elapsed: this.elapsed,
      stage: this.currentStage,
      lines_per_sec: this.intervalSec > 0 ? Math.round(this.lineCount / this.intervalSec) : 0,
      rule_hits: Object.fromEntries(this.ruleHitCounts),
      metrics: Object.fromEntries(this.metrics),
      output_pattern: this.detectOutputPattern(),
    };

    this.eventBus.emit(checkpoint);
    this.lineCount = 0;
    this.elapsed += this.intervalSec;
    return checkpoint;
  }

  private detectStage(line: string): void {
    for (const marker of this.bootMarkers) {
      if (line.includes(marker.text)) {
        const prev = this.currentStage;
        this.currentStage = marker.stage;
        if (prev !== marker.stage) {
          this.eventBus.emit({
            type: "stage_transition", from: prev, to: marker.stage, elapsed: this.elapsed,
          });
        }
        return;
      }
    }
  }

  private detectOutputPattern(): string {
    // P0: simplified - just return "stable"
    const rate = this.intervalSec > 0 ? this.lineCount / this.intervalSec : 0;
    if (rate === 0) return "silence";
    return "stable";
  }
}
