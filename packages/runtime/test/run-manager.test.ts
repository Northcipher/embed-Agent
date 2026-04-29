import { describe, it, expect } from "vitest";
import { RunManager } from "../src/run-manager.js";
import { StepQueue } from "../src/step-queue.js";
import { EventBus } from "../src/event-bus.js";
import type { RunRecord } from "@embed-agent/contracts";

describe("RunManager", () => {
  function setup() {
    const runs: RunRecord[] = [];
    const store = {
      create: async (r: RunRecord) => { runs.push(r); },
      update: async (_id: string, _p: Partial<RunRecord>) => {},
      get: async (id: string) => runs.find(r => r.run_id === id) ?? null,
    };
    const eb = new EventBus();
    const sq = new StepQueue();
    const se = { interrupt: () => {}, extendTimeout: () => {} } as never;
    const tm = {
      preflight: async () => ({ all_passed: true }),
      isBusy: () => false,
    };
    const rm = new RunManager(eb, store, tm, sq, se as never);
    return { rm, eb, runs, sq };
  }

  it("should create a run and transition to planning", async () => {
    const { rm, runs } = setup();
    const resp = await rm.createRun({
      context: { task: "test", expected: "boot" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    expect(resp.status).toBe("accepted");
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("planning");
  });

  it("should start execution and transition to running", async () => {
    const { rm } = setup();
    const resp = await rm.createRun({
      context: { task: "test", expected: "boot" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    await rm.startExecution(resp.run_id!, {
      plan_id: "p1", estimated_duration_sec: 60, steps: [],
      evidence_policy: { always: [], on_failure: [] },
      success_criteria: [], failure_signals: [],
    });
    expect(rm.getState(resp.run_id!)).toBe("running");
  });

  it("should pause and resume", async () => {
    const { rm } = setup();
    const resp = await rm.createRun({
      context: { task: "test", expected: "boot" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    await rm.startExecution(resp.run_id!, {
      plan_id: "p1", estimated_duration_sec: 60, steps: [],
      evidence_policy: { always: [], on_failure: [] },
      success_criteria: [], failure_signals: [],
    });
    await rm.pause(resp.run_id!);
    expect(rm.getState(resp.run_id!)).toBe("paused");
    await rm.resume(resp.run_id!);
    expect(rm.getState(resp.run_id!)).toBe("running");
  });

  it("should finalize a run", async () => {
    const { rm } = setup();
    const resp = await rm.createRun({
      context: { task: "test", expected: "boot" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    await rm.finalize(resp.run_id!, "completed");
    expect(rm.getState(resp.run_id!)).toBe("completed");
  });

  it("should cancel and finalize", async () => {
    const { rm } = setup();
    const resp = await rm.createRun({
      context: { task: "test", expected: "boot" },
      artifact: { path: "/test.img", type: "firmware_img" },
      target: "board-01",
    });
    await rm.cancel(resp.run_id!, "user request");
    expect(rm.getState(resp.run_id!)).toBe("cancelled");
  });
});
