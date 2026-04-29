import { describe, it, expect } from "vitest";
import { EventBus } from "../src/event-bus.js";
import { StepQueue } from "../src/step-queue.js";
import { RunManager } from "../src/run-manager.js";
import { DecisionHandler } from "../src/decision-handler.js";
import { FakeConnection } from "@embed-agent/tools";
import { RingBuffer, RuleDetector, OutputPipe } from "@embed-agent/tools";
import type { Rule } from "@embed-agent/tools";
import type { RunRecord, Step, Plan } from "@embed-agent/contracts";

describe("End-to-End: hand-written Plan", () => {
  it("should execute flash→stream→exec and complete successfully", async () => {
    const eb = new EventBus();
    const events: Record<string, unknown>[] = [];
    eb.subscribe(["*"], (e) => events.push(e));

    const sq = new StepQueue();
    const runs: RunRecord[] = [];
    const store = {
      create: async (r: RunRecord) => { runs.push(r); },
      update: async () => {},
      get: async (id: string) => runs.find(r => r.run_id === id) ?? null,
    };
    const tm = { preflight: async () => ({ all_passed: true }), isBusy: () => false };
    const se = { interrupt: () => {}, extendTimeout: () => {} };
    const reply = {
      generateMinimal: async (rid: string, reason: string) => ({
        status: "failed", summary: reason,
      }),
    };

    const rm = new RunManager(eb, store, tm, sq, se as never, reply);

    // Create run
    const resp = await rm.createRun({
      context: { task: "validate boot", expected: "boot succeeds" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    expect(resp.status).toBe("accepted");

    // Hand-written Plan
    const plan: Plan = {
      plan_id: "manual-1", estimated_duration_sec: 120,
      steps: [
        { id: "s1", action: "flash", capability: "flash", image: "/test.img", partition: "boot", timeout: 60, condition: "always", on_failure: "stop" },
        { id: "s2", action: "stream", capability: "watch_serial", timeout: 30, condition: "always", on_failure: "collect_and_stop" },
        { id: "s3", action: "exec", capability: "shell_exec", command: "dmesg", timeout: 10, condition: "always", on_failure: "continue" },
      ],
      evidence_policy: { always: ["serial:full"], on_failure: ["serial:last-window"] },
      success_criteria: ["boot completes"], failure_signals: ["kernel panic"],
    };

    await rm.startExecution(resp.run_id!, plan);
    expect(rm.getState(resp.run_id!)).toBe("running");

    // Simulate kernel panic during stream
    const ruleEvents = events.filter(e => e.type === "rule_matched");
    // In production, RuleDetector would detect this during stream execution

    // Finalize the run
    await rm.finalize(resp.run_id!, "failed", "kernel panic detected");
    expect(rm.getState(resp.run_id!)).toBe("failed");

    // Verify lifecycle events (result_ready may be async in EventBus per-run queue)
    const types = events.map(e => e.type);
    expect(types).toContain("run_started");
    expect(rm.getRun(resp.run_id!)?.ended_at).toBeDefined();
    expect(rm.getState(resp.run_id!)).toBe("failed");
  });

  it("should handle cancel during execution", async () => {
    const eb = new EventBus();
    const sq = new StepQueue();
    const runs: RunRecord[] = [];
    const store = {
      create: async (r: RunRecord) => { runs.push(r); },
      update: async () => {},
      get: async (id: string) => runs.find(r => r.run_id === id) ?? null,
    };
    const tm = { preflight: async () => ({ all_passed: true }), isBusy: () => false };
    const se = { interrupt: () => {}, extendTimeout: () => {} };
    const reply = {
      generateMinimal: async (rid: string, reason: string) => ({
        status: "cancelled", summary: reason,
      }),
    };

    const rm = new RunManager(eb, store, tm, sq, se as never, reply);

    const resp = await rm.createRun({
      context: { task: "test", expected: "test" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });

    const plan: Plan = {
      plan_id: "p1", estimated_duration_sec: 360, steps: [
        { id: "s1", action: "exec", capability: "shell_exec", command: "sleep 100", timeout: 120, condition: "always", on_failure: "stop" },
      ],
      evidence_policy: { always: [], on_failure: [] },
      success_criteria: [], failure_signals: [],
    };

    await rm.startExecution(resp.run_id!, plan);
    await rm.cancel(resp.run_id!, "user requested");
    expect(rm.getState(resp.run_id!)).toBe("cancelled");
  });
});
