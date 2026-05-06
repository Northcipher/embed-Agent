import { describe, it, expect, vi } from "vitest";
import { Views } from "../src/views.js";

const mockRunStore = {
  get: async (id: string) => id === "r1" ? {
    run_id: "r1", state: "running", target_id: "t1", elapsed_sec: 120, last_event_seq: 5,
    evidence_root: "/tmp/runs/r1", artifact: { path: "/tmp/test.img", type: "firmware" },
    created_at: "2026-01-01T00:00:00Z",
  } : id === "r2" ? {
    run_id: "r2", state: "completed", target_id: "t1", elapsed_sec: 300, last_event_seq: 10,
    evidence_root: "/tmp/runs/r2", artifact: { path: "/tmp/test.img", type: "firmware", build_id: "b123" },
    created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:02Z", ended_at: "2026-01-01T00:05:01Z",
  } : null,
  listNonTerminal: async () => [{ run_id: "r1", state: "running", target_id: "t1" }],
};

const mockEventStore = {
  read: async (runId: string) => {
    if (runId === "r2") {
      return [
        { seq: 1, type: "llm_call", summary: "planner", payload: { role: "planner", raw_content: JSON.stringify({ steps: [{ id: "s1", capability: "shell_exec", action: "exec", command: "uname -a", timeout_sec: 15 }] }) }, time: "2026-01-01T00:00:01Z" },
        { seq: 2, type: "run_started", summary: "started", payload: { plan_id: "plan-1", task: "Validate firmware on t1", expected: "boot ok" }, time: "2026-01-01T00:00:02Z" },
        { seq: 3, type: "step_started", step_id: "s1", summary: "Step s1 started", payload: { capability: "shell_exec", action: "exec" }, time: "2026-01-01T00:00:03Z" },
        { seq: 4, type: "observation", step_id: "s1", summary: "exec complete", payload: { step_id: "s1", exit_code: 0 }, time: "2026-01-01T00:00:04Z" },
        { seq: 5, type: "step_completed", step_id: "s1", summary: "Step s1 completed", payload: {}, time: "2026-01-01T00:00:05Z" },
        { seq: 8, type: "result_ready", summary: "Run completed successfully", payload: { status: "completed", summary: "All checks passed", suggested_next: "deploy to staging", evidence_path: "/tmp/runs/r2", confidence: 0.96, key_evidence: [{ summary: "boot OK", evidence_refs: ["serial:full"] }], criteria_results: [{ criterion: "boot ok", status: "pass", evidence_refs: ["serial:full"] }] }, time: "2026-01-01T00:05:00Z" },
        { seq: 9, type: "run_completed", summary: "done", payload: {}, time: "2026-01-01T00:05:01Z" },
      ];
    }
    if (runId === "serial-fallback") {
      return [
        { seq: 1, type: "llm_call", summary: "planner: fallback_error", payload: { role: "planner", fallback: true, source: "fallback_error", error: "planner endpoint timeout" }, time: "2026-01-01T00:00:01Z" },
        { seq: 2, type: "plan_generated", summary: "Plan with 1 steps", payload: { plan_id: "plan-serial", estimated_duration_sec: 60 }, time: "2026-01-01T00:00:02Z" },
        { seq: 3, type: "run_started", summary: "started", payload: { plan_id: "plan-serial", task: "serial smoke", expected: "read serial" }, time: "2026-01-01T00:00:03Z" },
        { seq: 4, type: "step_started", step_id: "fb_serial_stream", summary: "Step fb_serial_stream started", payload: { capability: "serial_output", action: "stream" }, time: "2026-01-01T00:00:04Z" },
        { seq: 5, type: "observation", step_id: "fb_serial_stream", summary: "100 lines processed", payload: { step_id: "fb_serial_stream", lines: 100 }, time: "2026-01-01T00:00:05Z" },
        { seq: 6, type: "observation", step_id: "fb_serial_stream", summary: "100 lines processed", payload: { step_id: "fb_serial_stream", lines: 100 }, time: "2026-01-01T00:00:06Z" },
        { seq: 7, type: "step_completed", step_id: "fb_serial_stream", summary: "Step fb_serial_stream completed", payload: {}, time: "2026-01-01T00:01:05Z" },
        { seq: 8, type: "llm_call", summary: "reply: fallback_error", payload: { role: "reply", fallback: true, source: "fallback_error", error: "reply endpoint returned 401" }, time: "2026-01-01T00:01:06Z" },
        { seq: 9, type: "result_ready", summary: "LLM degraded after tool fallback", payload: { status: "completed", summary: "LLM degraded after tool fallback", suggested_next: "check evidence manually", evidence_path: "/tmp/runs/serial-fallback", confidence: 0.5 }, time: "2026-01-01T00:01:07Z" },
        { seq: 10, type: "run_completed", summary: "done", payload: {}, time: "2026-01-01T00:01:08Z" },
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
    refs: [
      { ref: "serial:full", kind: "log" as const, available: true, bytes: 1024 },
      { ref: "step-s1:full", kind: "log" as const, available: true, bytes: 512 },
    ],
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
  listByTarget: async () => [{ episode_id: "e1", run_id: "older-run", result: "completed", summary: "test", recorded_at: "2026-01-01T00:06:00Z" }],
};

describe("Views", () => {
  const views = new Views(mockRunStore, mockEventStore, mockEvidenceStore, mockTargetStore, mockMemoryStore);

  it("status returns run state", async () => {
    const s = await views.status("r1");
    expect(s?.state).toBe("running");
  });

  it("status reports live elapsed time from run timestamps", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-01-01T00:00:07Z").getTime());
    try {
      const statusViews = new Views({
        ...mockRunStore,
        get: async () => ({
          run_id: "planning-run", state: "planning", target_id: "t1", elapsed_sec: 0, last_event_seq: 0,
          evidence_root: "/tmp/runs/planning-run", artifact: { path: "/tmp/test.img", type: "firmware" },
          created_at: "2026-01-01T00:00:02Z",
        }),
      }, mockEventStore, mockEvidenceStore, mockTargetStore, mockMemoryStore);

      const s = await statusViews.status("planning-run");

      expect(s?.elapsed_sec).toBe(5);
    } finally {
      nowSpy.mockRestore();
    }
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

  it("result includes engineer review context", async () => {
    const r = await views.result("r2");
    expect(r.target_id).toBe("t1");
    expect(r.artifact).toMatchObject({ path: "/tmp/test.img", type: "firmware", build_id: "b123" });
    expect(r.task).toBe("Validate firmware on t1");
    expect(r.expected).toBe("boot ok");
    expect(r.plan_id).toBe("plan-1");
    expect(r.confidence).toBe(0.96);
    expect(r.timing).toMatchObject({ created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:02Z", ended_at: "2026-01-01T00:05:01Z", elapsed_sec: 299 });
    expect(r.steps).toEqual([expect.objectContaining({ id: "s1", status: "completed", capability: "shell_exec", action: "exec", command: "uname -a", exit_code: 0, evidence_refs: ["step-s1:full"] })]);
    expect(r.evidence_index).toContainEqual(expect.objectContaining({ ref: "serial:full", available: true }));
    expect(r.event_summary).toMatchObject({ total: 7, warnings: 0, fatals: 0, llm_calls: 1 });
    expect(r.related_history).toEqual([expect.objectContaining({ run_id: "older-run", result: "completed" })]);
  });

  it("result summarizes successful device execution separately from LLM fallback", async () => {
    const viewsWithSerialFallback = new Views({
      ...mockRunStore,
      get: async () => ({
        run_id: "serial-fallback", state: "completed", target_id: "serial-target", elapsed_sec: 64, last_event_seq: 10,
        evidence_root: "/tmp/runs/serial-fallback", artifact: { path: "/tmp/package.json", type: "serial-smoke" },
        created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:03Z", ended_at: "2026-01-01T00:01:08Z",
      }),
    }, mockEventStore, mockEvidenceStore, mockTargetStore, mockMemoryStore);

    const r = await viewsWithSerialFallback.result("serial-fallback");

    expect(r.process_summary).toContainEqual(expect.objectContaining({
      kind: "device",
      status: "ok",
      title: "Device step completed",
    }));
    expect(r.process_summary).toContainEqual(expect.objectContaining({
      kind: "evidence",
      status: "ok",
      title: "Log captured",
      detail: "200 lines processed; 2 log files available",
    }));
    expect(r.process_summary).toContainEqual(expect.objectContaining({
      kind: "llm",
      status: "warn",
      title: "Result text used fallback",
      detail: "planner, reply unavailable: reply endpoint returned 401; device execution still used collected evidence",
    }));
  });

  it("result for non-terminal returns not-ready", async () => {
    const r = await views.result("r1");
    expect(r.result_available).toBe(false);
  });

  it("result duration uses run timestamps instead of stored elapsed seconds", async () => {
    const r = await views.result("r2");
    expect(r.timing?.elapsed_sec).toBe(299);
  });

  it("history includes timestamp-based duration fields from the run store", async () => {
    const historyViews = new Views({
      ...mockRunStore,
      get: async () => ({
        run_id: "older-run", state: "completed", target_id: "t1", elapsed_sec: 999, last_event_seq: 10,
        evidence_root: "/tmp/runs/older-run", artifact: { path: "/tmp/older.img", type: "firmware" },
        created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:10Z", ended_at: "2026-01-01T00:01:15Z",
      }),
    }, mockEventStore, mockEvidenceStore, mockTargetStore, mockMemoryStore);

    const history = await historyViews.history("t1", 5);

    expect(history).toEqual([expect.objectContaining({
      run_id: "older-run",
      state: "completed",
      elapsed_sec: 65,
      created_at: "2026-01-01T00:00:00Z",
      started_at: "2026-01-01T00:00:10Z",
      ended_at: "2026-01-01T00:01:15Z",
      artifact_ref: "/tmp/older.img",
    })]);
  });

  it("targets includes all targets from TargetStore", async () => {
    const t = await views.targets();
    expect(t).toHaveLength(2);
    expect(t.find(x => x.target_id === "t2")?.state).toBe("idle");
  });

  it("evidence returns index", async () => {
    const ev = await views.evidence("r1");
    expect(ev.available).toBe(true);
    expect(ev.index?.refs).toHaveLength(2);
  });
});
