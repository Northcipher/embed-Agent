import { describe, it, expect, vi } from "vitest";
import { RuleDetector, type Rule } from "../src/rule-detector.js";

function makeRingBuffer(lines: string[]) {
  return {
    lines,
    getWindow(hitIndex: number, _before: number, _after: number) {
      return [this.lines[hitIndex] ?? ""];
    },
  };
}

describe("RuleDetector", () => {
  const systemRules: Rule[] = [
    { id: "kernel_panic", kind: "pattern", pattern: /kernel panic/i, severity: "fatal", source: "system", debounce_sec: 30 },
    { id: "kernel_oops", kind: "pattern", pattern: /kernel oops/i, severity: "fatal", source: "system", debounce_sec: 30 },
  ];

  it("should emit on pattern match", () => {
    const events: Record<string, unknown>[] = [];
    const eb = { emit: (e: Record<string, unknown>) => events.push(e) };
    const rd = new RuleDetector(makeRingBuffer(["kernel panic - not syncing"]), eb);
    rd.loadRunRules(systemRules, [], []);

    rd.detect("kernel panic - not syncing", 0);
    expect(events).toHaveLength(1);
    expect(events[0].rule_id).toBe("kernel_panic");
    expect(events[0].severity).toBe("fatal");
  });

  it("should not emit when no match", () => {
    const events: Record<string, unknown>[] = [];
    const eb = { emit: (e: Record<string, unknown>) => events.push(e) };
    const rd = new RuleDetector(makeRingBuffer(["normal output"]), eb);
    rd.loadRunRules(systemRules, [], []);

    rd.detect("normal output", 0);
    expect(events).toHaveLength(0);
  });

  it("should support step-level patterns", () => {
    const events: Record<string, unknown>[] = [];
    const eb = { emit: (e: Record<string, unknown>) => events.push(e) };
    const rd = new RuleDetector(makeRingBuffer(["foo error"]), eb);
    rd.loadRunRules([], [], []);
    rd.loadStepPatterns(["foo error"]);

    rd.detect("foo error", 0);
    expect(events).toHaveLength(1);

    rd.clearStepPatterns();
    const events2: Record<string, unknown>[] = [];
    // Re-create with cleared patterns
    const rd2 = new RuleDetector(makeRingBuffer(["foo error"]), { emit: (e: Record<string, unknown>) => events2.push(e) });
    rd2.loadRunRules([], [], []);
    rd2.detect("foo error", 0);
    expect(events2).toHaveLength(0);
  });

  it("should emit on exit code mismatch", () => {
    const events: Record<string, unknown>[] = [];
    const eb = { emit: (e: Record<string, unknown>) => events.push(e) };
    const exitRules: Rule[] = [
      { id: "smoke_fail", kind: "exit_code", expected_exit_code: 0, severity: "warning", source: "plan", debounce_sec: 30 },
    ];
    const rd = new RuleDetector(makeRingBuffer([]), eb);
    rd.loadRunRules([], exitRules, []);
    rd.checkExitCode(1);
    expect(events).toHaveLength(1);
  });

  it("should not emit on exit code match", () => {
    const events: Record<string, unknown>[] = [];
    const eb = { emit: (e: Record<string, unknown>) => events.push(e) };
    const exitRules: Rule[] = [
      { id: "smoke_ok", kind: "exit_code", expected_exit_code: 0, severity: "warning", source: "plan", debounce_sec: 30 },
    ];
    const rd = new RuleDetector(makeRingBuffer([]), eb);
    rd.loadRunRules([], exitRules, []);
    rd.checkExitCode(0);
    expect(events).toHaveLength(0);
  });
});
