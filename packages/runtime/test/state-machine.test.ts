import { describe, it, expect } from "vitest";
import { RunManager } from "../src/run-manager.js";
import { StepQueue } from "../src/step-queue.js";
import type { RunRecord } from "@embed-agent/contracts";

describe("State machine transitions", () => {
  function setup(state: RunRecord["state"] = "planning") {
    const runs: RunRecord[] = [{
      run_id: "run-001", session_id: "s1", state, target_id: "t1",
      artifact: { path: "/x", type: "img" }, elapsed_sec: 0, last_event_seq: 0,
      evidence_root: "/x", created_at: new Date().toISOString(),
    }];
    const store = { create: async () => {}, update: async () => {}, get: async () => runs[0] ?? null };
    const eb = { emit: () => {}, subscribe: () => () => {} };
    const sq = new StepQueue();
    const se = { interrupt: () => {}, extendTimeout: () => {} };
    const tm = { preflight: async () => ({ all_passed: true }), isBusy: () => false };
    return new RunManager(eb as never, store, tm, sq, se as never);
  }

  it("should reject pause when not running", async () => {
    const rm = setup("planning");
    await rm.pause("run-001");
    expect(rm.getState("run-001")).toBe("planning"); // unchanged
  });

  it("should reject resume when not paused", async () => {
    const rm = setup("running");
    await rm.resume("run-001");
    expect(rm.getState("run-001")).toBe("running"); // unchanged
  });

  it("should allow pause when running", async () => {
    const rm = setup("running");
    await rm.pause("run-001");
    expect(rm.getState("run-001")).toBe("paused");
  });

  it("should allow resume when paused", async () => {
    const rm = setup("paused");
    await rm.resume("run-001");
    expect(rm.getState("run-001")).toBe("running");
  });

  it("should allow cancel from any non-terminal state", async () => {
    const rm = setup("running");
    await rm.cancel("run-001", "test");
    expect(rm.getState("run-001")).toBe("cancelled");
  });

  it("should transition through full lifecycle", async () => {
    const rm = setup("planning");
    expect(rm.getState("run-001")).toBe("planning");

    // planning → running (via startExecution)
    await rm.startExecution("run-001", {
      plan_id: "p1", estimated_duration_sec: 60, steps: [],
      evidence_policy: { always: [], on_failure: [] },
      success_criteria: [], failure_signals: [],
    });
    expect(rm.getState("run-001")).toBe("running");

    // running → paused
    await rm.pause("run-001");
    expect(rm.getState("run-001")).toBe("paused");

    // paused → running
    await rm.resume("run-001");
    expect(rm.getState("run-001")).toBe("running");

    // running → failed (via finalize)
    await rm.finalize("run-001", "failed", "kernel panic");
    expect(rm.getState("run-001")).toBe("failed");
  });
});
