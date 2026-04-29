export type RuleKind = "pattern" | "silence" | "exit_code" | "timeout" | "connectivity";
export type RuleSeverity = "fatal" | "warning" | "info";

export interface Rule {
  id: string;
  kind: RuleKind;
  pattern?: RegExp;
  silence_sec?: number;
  expected_exit_code?: number;
  severity: RuleSeverity;
  source: "system" | "target" | "plan" | "memory";
  capture?: { before_lines: number; after_lines: number; ref: string };
  debounce_sec: number;
}

export interface RuleDetectorOutput {
  emit(event: Record<string, unknown>): void;
}

export interface RingBufferReader {
  getWindow(hitIndex: number, before: number, after: number): string[];
}

export class RuleDetector {
  private systemRules: Rule[] = [];
  private targetPatterns: Rule[] = [];
  private knownIssuePatterns: Rule[] = [];
  private stepPatterns: Rule[] = [];

  constructor(
    private ringBuffer: RingBufferReader,
    private eventBus: RuleDetectorOutput,
  ) {}

  loadRunRules(system: Rule[], target: Rule[], known: Rule[]): void {
    this.systemRules = system;
    this.targetPatterns = target;
    this.knownIssuePatterns = known;
  }

  loadStepPatterns(patterns: string[]): void {
    this.stepPatterns = patterns.map(p => ({
      id: `step_${p.slice(0, 20)}`,
      kind: "pattern" as const,
      pattern: new RegExp(p),
      severity: "warning" as RuleSeverity,
      source: "plan" as const,
      debounce_sec: 30,
    }));
  }

  clearStepPatterns(): void {
    this.stepPatterns = [];
  }

  get activeRules(): Rule[] {
    return [...this.systemRules, ...this.targetPatterns, ...this.knownIssuePatterns, ...this.stepPatterns];
  }

  detect(line: string, lineIndex: number): void {
    for (const rule of this.activeRules) {
      if (rule.kind === "pattern" && rule.pattern?.test(line)) {
        const before = rule.capture?.before_lines ?? 200;
        const after = rule.capture?.after_lines ?? 80;
        const window = this.ringBuffer.getWindow(lineIndex, before, after);
        this.eventBus.emit({
          type: "rule_matched",
          rule_id: rule.id,
          severity: rule.severity,
          source: "rule_detector",
          summary: `Rule ${rule.id} matched`,
          payload: { pattern: rule.pattern?.source },
          evidence_refs: [rule.capture?.ref ?? "serial:last-window"],
        });
      }
    }
  }

  checkExitCode(exitCode: number): void {
    for (const rule of this.activeRules) {
      if (rule.kind === "exit_code" && rule.expected_exit_code !== undefined && exitCode !== rule.expected_exit_code) {
        this.eventBus.emit({
          type: "rule_matched",
          rule_id: rule.id,
          severity: rule.severity,
          source: "rule_detector",
          summary: `Exit code ${exitCode} != expected ${rule.expected_exit_code}`,
          payload: { exit_code: exitCode, expected: rule.expected_exit_code },
        });
      }
    }
  }

  checkTimeout(stepId: string, elapsedSec: number, timeoutSec: number): void {
    if (elapsedSec >= timeoutSec) {
      this.eventBus.emit({
        type: "step_timeout",
        rule_id: "step_timeout",
        severity: "warning",
        source: "rule_detector",
        step_id: stepId,
        summary: `Step ${stepId} timed out after ${elapsedSec}s`,
        payload: { elapsed_sec: elapsedSec, timeout_sec: timeoutSec },
      });
    }
  }

  checkConnectivity(connectionState: string): void {
    if (connectionState === "disconnected" || connectionState === "error") {
      this.eventBus.emit({
        type: "target_state_changed",
        rule_id: "connectivity_lost",
        severity: "warning",
        source: "rule_detector",
        summary: `Connection state: ${connectionState}`,
        payload: { state: connectionState },
      });
    }
  }
}
