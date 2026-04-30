import { describe, it, expect } from "vitest";
import { Views } from "../src/views.js";

const mockRunStore = {
  get: async (id: string) => id === "r1" ? {
    run_id: "r1", state: "running", target_id: "t1", elapsed_sec: 120, last_event_seq: 5,
    evidence_root: "/tmp/runs/r1", artifact: { path: "/tmp/test.img", type: "firmware" },
    created_at: "2026-01-01T00:00:00Z",
  } : id === "r2" ? {
    run_id: "r2", state: "completed", target_id: "t1", elapsed_sec: 300, last_event_seq: 10,
    evidence_root: "/tmp/runs/r2", artifact: { path: "/tmp/test.img", type: "firmware" },
    created_at: "2026-01-01T00:00:00Z",
  } : null,
  listNonTerminal: async () => [{ run_id: "r1", state: "running", target_id: "t1" }],
};

const mockEventStore = {
  read: async (runId: string) => {
    if (runId === "r2") {
      return [
        { seq: 8, type: "result_ready", summary: "Run completed successfully", payload: { status: "completed", summary: "All checks passed", suggested_next: "deploy to staging", evidence_path: "/tmp/runs/r2", key_evidence: [{ summary: "boot OK", evidence_refs: ["serial:full"] }] }, time: "2026-01-01T00:05:00Z" },
        { seq: 9, type: "run_completed", summary: "done", payload: {}, time: "2026-01-01T00:05:01Z" },
      ];
    }
    return [
      { seq: 1, type: "run_started", summary: "started", payload: {}, time: "2026-01-01T00:00:00Z" },
      { seq: 2, type: "step_started", summary: "step 1", payload: {}, time: "2026-01-01T00:00:01Z", step_id: "s1" },
    ];
  },
};

const mockEvidenceStore = {
  read: async () => ({ filePath: "/tmp/test.log", size: 1024, available: true }),
  getIndex: async () => ({
    refs: [{ ref: "serial:full", kind: "log" as const, available: true, bytes: 1024 }],
    key_events: [{ seq: 1, summary: "test", evidence_refs: [] }],
  }),
};

const mockTargetStore = {
  getState: async () => ({ state: "busy", serial: "connected", adb: "online", fastboot: "disconnected" }),
  listAll: async () => [{ target_id: "t1" }, { target_id: "t2" }],
  listStates: async () => [
    { target_id: "t1", state: "busy", serial: "connected", adb: "online", fastboot: "disconnected", current_run_id: "r1" },
    { target_id: "t2", state: "idle", serial: "disconnected", adb: "disconnected", fastboot: "disconnected" },
  ],
};

const mockMemoryStore = {
  listByTarget: async () => [{ episode_id: "e1", result: "completed", summary: "test" }],
};

describe("Views", () => {
  const views = new Views(mockRunStore, mockEventStore, mockEvidenceStore, mockTargetStore, mockMemoryStore);

  it("status returns run state", async () => {
    const s = await views.status("r1");
    expect(s?.state).toBe("running");
  });

  it("events returns paginated events", async () => {
    const result = await views.events("r1");
    expect(result.events).toHaveLength(2);
  });

  it("result reads result_ready event", async () => {
    const r = await views.result("r2");
    expect(r.result_available).toBe(true);
    expect(r.summary).toBe("All checks passed");
    expect(r.suggested_next).toBe("deploy to staging");
  });

  it("result for non-terminal returns not-ready", async () => {
    const r = await views.result("r1");
    expect(r.result_available).toBe(false);
  });

  it("targets includes all targets from TargetStore", async () => {
    const t = await views.targets();
    expect(t).toHaveLength(2);
    expect(t.find(x => x.target_id === "t2")?.state).toBe("idle");
  });

  it("evidence returns index", async () => {
    const ev = await views.evidence("r1");
    expect(ev.available).toBe(true);
    expect(ev.index?.refs).toHaveLength(1);
  });
});
