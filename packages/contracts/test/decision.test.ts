import { describe, it, expect } from "vitest";
import type { Decision, DecisionType } from "../src/decision.js";

describe("DecisionType", () => {
  it("should have 12 decision types", () => {
    const types: DecisionType[] = [
      "stop", "continue", "collect_more", "extend_wait",
      "pause", "resume", "cancel", "ignore_rule",
      "suggest", "observe_more_frequent", "observe_again_at",
      "override_decision",
    ];
    expect(types).toHaveLength(12);
  });
});

describe("Decision", () => {
  it("should create a stop decision", () => {
    const d: Decision = {
      decision: "stop",
      reason: "kernel panic detected",
      confidence: 0.95,
      reasoning_trace: "fatal pattern match at line 342",
      evidence_refs: ["serial:last-280-lines"],
    };
    expect(d.decision).toBe("stop");
    expect(d.confidence).toBeGreaterThan(0.9);
  });

  it("should create an extend_wait with params", () => {
    const d: Decision = {
      decision: "extend_wait",
      reason: "device still booting",
      confidence: 0.7,
      reasoning_trace: "serial silence but ADB not yet online",
      evidence_refs: [],
      params: { extra_wait_sec: 30 },
    };
    expect(d.params?.extra_wait_sec).toBe(30);
  });

  it("should create a suggest with suggestion text", () => {
    const d: Decision = {
      decision: "suggest",
      reason: "memory trend increasing",
      confidence: 0.6,
      reasoning_trace: "memory +25% over 35 min",
      evidence_refs: [],
      suggestion: "建议关注 foo 模块内存释放",
    };
    expect(d.suggestion).toBeDefined();
  });
});
