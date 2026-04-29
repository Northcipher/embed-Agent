import { describe, it, expect } from "vitest";
import { RunManager } from "../src/run-manager.js";
import { StepQueue } from "../src/step-queue.js";
import type { RunRecord } from "@embed-agent/contracts";

function setup() {
  const runs: RunRecord[] = [];
  const store = { create: async (r: RunRecord) => { runs.push(r); }, update: async () => {}, get: async (id: string) => runs.find(r => r.run_id === id) ?? null };
  const eb = { emit: () => {}, subscribe: () => () => {} };
  const sq = new StepQueue();
  const se = { interrupt: () => {}, extendTimeout: () => {} };
  const tm = { preflight: async () => ({ all_passed: true }), isBusy: () => false };
  return new RunManager(eb as never, store, tm, sq, se as never);
}

async function createAndStart(rm: RunManager) {
  const resp = await rm.createRun({
    context: { task: "test", expected: "test" },
    artifact: { path: "/x", type: "img" },
    target: "t1",
  });
  await rm.startExecution(resp.run_id!, { plan_id: "p1", estimated_duration_sec: 60, steps: [], evidence_policy: { always: [], on_failure: [] }, success_criteria: [], failure_signals: [] });
  return resp.run_id!;
}

describe("State machine transitions", () => {
  it("should reject pause when not running", async () => {
    const rm = setup();
    const rid = (await rm.createRun({ context: { task:"t",expected:"e" }, artifact: { path:"/x",type:"img" }, target:"t1" })).run_id!;
    await rm.pause(rid);
    expect(rm.getState(rid)).toBe("planning"); // not running, unchanged
  });

  it("should reject resume when not paused", async () => {
    const rm = setup();
    const rid = await createAndStart(rm);
    await rm.resume(rid);
    expect(rm.getState(rid)).toBe("running"); // not paused, unchanged
  });

  it("should allow pause when running", async () => {
    const rm = setup();
    const rid = await createAndStart(rm);
    await rm.pause(rid);
    expect(rm.getState(rid)).toBe("paused");
  });

  it("should allow resume when paused", async () => {
    const rm = setup();
    const rid = await createAndStart(rm);
    await rm.pause(rid);
    await rm.resume(rid);
    expect(rm.getState(rid)).toBe("running");
  });

  it("should allow cancel", async () => {
    const rm = setup();
    const rid = await createAndStart(rm);
    await rm.cancel(rid, "test");
    expect(rm.getState(rid)).toBe("cancelled");
  });

  it("should transition through full lifecycle", async () => {
    const rm = setup();
    const rid = await createAndStart(rm);
    expect(rm.getState(rid)).toBe("running");
    await rm.pause(rid);
    expect(rm.getState(rid)).toBe("paused");
    await rm.resume(rid);
    expect(rm.getState(rid)).toBe("running");
    await rm.finalize(rid, "failed", "test");
    expect(rm.getState(rid)).toBe("failed");
  });
});
