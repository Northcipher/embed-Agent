import type { RingBuffer } from "./ring-buffer.js";

export type RuleSeverity = "fatal" | "warning" | "info";

export interface Rule {
  id: string;
  kind: "pattern" | "silence" | "exit_code" | "timeout" | "connectivity";
  pattern?: RegExp;
  expected_exit_code?: number;
  severity: RuleSeverity;
  source: "system" | "target" | "plan" | "memory";
  capture?: { before_lines: number; after_lines: number; ref: string };
  debounce_sec: number;
}

interface Emitter { emit(e: Record<string, unknown>): void; }
interface EvidenceSaver { saveWindow(runId: string, ref: string, data: string): Promise<void>; }

export class RuleDetector {
  private system: Rule[] = [];
  private target: Rule[] = [];
  private known: Rule[] = [];
  private step: Rule[] = [];

  constructor(
    private rb: RingBuffer,
    private eb: Emitter,
    private evidence?: EvidenceSaver,
    private runId?: string,
  ) {}

  loadRunRules(sys: Rule[], tgt: Rule[], knw: Rule[]): void {
    this.system = sys; this.target = tgt; this.known = knw;
  }

  loadStepPatterns(patterns: string[]): void {
    this.step = patterns.map(p => ({
      id: `step_${p.slice(0, 20)}`, kind: "pattern" as const,
      pattern: new RegExp(p), severity: "warning" as RuleSeverity,
      source: "plan" as const, debounce_sec: 30,
    }));
  }

  clearStepPatterns(): void { this.step = []; }

  private get active(): Rule[] { return [...this.system, ...this.target, ...this.known, ...this.step]; }

  detect(line: string, lineIdx: number): void {
    for (const r of this.active) {
      if (r.kind === "pattern" && r.pattern?.test(line)) {
        const before = r.capture?.before_lines ?? 200;
        const after = r.capture?.after_lines ?? 80;
        const window = this.rb.getWindow(lineIdx, before, after);
        const ref = r.capture?.ref ?? "serial:last-window";

        // Write evidence window
        if (this.evidence && this.runId) {
          this.evidence.saveWindow(this.runId, ref, window.join("\n")).catch(() => {});
        }

        this.eb.emit({
          type: "rule_matched", rule_id: r.id, severity: r.severity,
          source: "rule_detector", step_id: undefined,
          summary: `Rule ${r.id} matched`,
          payload: { pattern: r.pattern.source },
          evidence_refs: [ref],
        });
      }
    }
  }

  checkExitCode(exitCode: number): void {
    for (const r of this.active) {
      if (r.kind === "exit_code" && r.expected_exit_code !== undefined && exitCode !== r.expected_exit_code) {
        this.eb.emit({ type: "rule_matched", rule_id: r.id, severity: r.severity, source: "rule_detector", summary: `Exit code ${exitCode} != ${r.expected_exit_code}`, payload: { exit_code: exitCode } });
      }
    }
  }

  checkTimeout(stepId: string, elapsed: number, timeout: number): void {
    if (elapsed >= timeout) {
      this.eb.emit({ type: "step_timeout", rule_id: "step_timeout", severity: "warning", source: "rule_detector", step_id: stepId, summary: `Step ${stepId} timed out`, payload: { elapsed_sec: elapsed, timeout_sec: timeout } });
    }
  }

  checkConnectivity(state: string): void {
    if (state === "disconnected" || state === "error") {
      this.eb.emit({ type: "target_state_changed", rule_id: "connectivity", severity: "warning", source: "rule_detector", summary: `Connection: ${state}`, payload: { state } });
    }
  }
}
