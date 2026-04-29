import { describe, it, expect } from "vitest";
import type { EventType, Event } from "../src/event.js";

describe("EventType", () => {
  it("should have all lifecycle events", () => {
    const lifecycle: EventType[] = [
      "run_started", "plan_generated", "step_started", "step_completed",
      "step_failed", "run_completed", "run_failed", "run_cancelled",
      "run_paused", "run_resumed", "result_ready",
    ];
    expect(lifecycle).toHaveLength(11);
  });

  it("should have all decision events", () => {
    const decision: EventType[] = [
      "decision_made", "decision_rejected", "suggestion_generated",
      "rule_ignored", "decision_overridden",
    ];
    expect(decision).toHaveLength(5);
  });

  it("should have all signal events", () => {
    const signal: EventType[] = ["correlated", "baseline_diff", "stage_transition"];
    expect(signal).toHaveLength(3);
  });
});

describe("Event", () => {
  it("should create a minimal run event", () => {
    const event: Event = {
      seq: 1,
      run_id: "run-001",
      time: "2026-04-29T00:00:00Z",
      type: "run_started",
      source: "run_manager",
      summary: "Run started",
      payload: {},
    };
    expect(event.run_id).toBe("run-001");
    expect(event.type).toBe("run_started");
  });

  it("should create a global event (no run_id)", () => {
    const event: Event = {
      seq: 100,
      time: "2026-04-29T00:00:00Z",
      type: "target_state_changed",
      source: "connection_manager",
      summary: "Target board-01 serial disconnected",
      payload: { serial: "disconnected" },
    };
    expect(event.run_id).toBeUndefined();
  });

  it("should create a rule_matched event with evidence refs", () => {
    const event: Event = {
      seq: 42,
      run_id: "run-001",
      time: "2026-04-29T00:00:42Z",
      elapsed_sec: 42,
      type: "rule_matched",
      severity: "fatal",
      source: "rule_detector",
      step_id: "step-2",
      summary: "kernel panic detected",
      payload: { pattern: "kernel panic" },
      evidence_refs: ["serial:last-280-lines"],
    };
    expect(event.severity).toBe("fatal");
    expect(event.evidence_refs).toHaveLength(1);
  });
});
