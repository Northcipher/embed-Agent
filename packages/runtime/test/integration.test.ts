import { describe, it, expect } from "vitest";
import { EventBus } from "../src/event-bus.js";
import { StepQueue } from "../src/step-queue.js";
import { RunManager } from "../src/run-manager.js";
import { DecisionHandler } from "../src/decision-handler.js";
import { FakeConnection } from "@embed-agent/tools";
import { RingBuffer } from "@embed-agent/tools";
import { RuleDetector } from "@embed-agent/tools";
import type { Rule } from "@embed-agent/tools";
import type { RunRecord, Step, Plan } from "@embed-agent/contracts";

describe("Integration: boot validation", () => {
  function setup() {
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

    const rm = new RunManager(eb, store, tm, sq, se as never);

    // RuleDetector for kernel panic detection
    const fakeConn = new FakeConnection();
    const rb = new RingBuffer(500);
    const systemRules: Rule[] = [
      { id: "kernel_panic", kind: "pattern", pattern: /kernel panic/i, severity: "fatal", source: "system", debounce_sec: 30 },
    ];
    const rd = new RuleDetector(rb, { emit: (e) => eb.emit(e) });
    rd.loadRunRules(systemRules, [], []);

    const dh = new DecisionHandler(eb, se as never, sq);

    return { eb, rm, sq, rd, dh, fakeConn, rb };
  }

  it("should detect kernel panic and stop", async () => {
    const { eb, rm, rd, fakeConn, rb } = setup();

    const events: Record<string, unknown>[] = [];
    eb.subscribe(["*"], (e) => events.push(e));

    // Create run
    const resp = await rm.createRun({
      context: { task: "validate boot", expected: "boot succeeds" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    expect(resp.status).toBe("accepted");

    // Simulate serial output with kernel panic
    const lines = [
      "Booting Linux...",
      "init started",
      "kernel panic - not syncing: Attempted to kill init!",
      "---[ end Kernel panic ]---",
    ];

    for (let i = 0; i < lines.length; i++) {
      rb.push(lines[i]!);
      rd.detect(lines[i]!, i);
    }

    // Verify rule matched event
    const ruleEvents = events.filter(e => e.type === "rule_matched");
    expect(ruleEvents.length).toBeGreaterThanOrEqual(1);
    expect(ruleEvents[0].rule_id).toBe("kernel_panic");
    expect(ruleEvents[0].severity).toBe("fatal");
  });

  it("should complete full lifecycle: planning → running → completed", async () => {
    const { rm } = setup();

    const resp = await rm.createRun({
      context: { task: "validate boot", expected: "boot succeeds" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });

    expect(rm.getState(resp.run_id!)).toBe("planning");

    const plan: Plan = {
      plan_id: "p1", estimated_duration_sec: 60, steps: [],
      evidence_policy: { always: [], on_failure: [] },
      success_criteria: ["boot completes"], failure_signals: ["kernel panic"],
    };
    await rm.startExecution(resp.run_id!, plan);
    expect(rm.getState(resp.run_id!)).toBe("running");

    await rm.finalize(resp.run_id!, "completed");
    expect(rm.getState(resp.run_id!)).toBe("completed");
  });

  it("should handle circuit breaker: override 3x → active", () => {
    const dh = new DecisionHandler(
      { emit: () => {}, subscribe: () => () => {} } as never,
      {} as never, {} as never,
    );
    expect(dh.isObserverBreakerActive()).toBe(false);
    dh.onOverride(); dh.onOverride(); dh.onOverride();
    expect(dh.isObserverBreakerActive()).toBe(true);
  });
});
