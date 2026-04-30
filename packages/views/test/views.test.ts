import { describe, it, expect } from "vitest";
import { Views } from "../src/views.js";

const mockRunStore = {
  get: async (id: string) => id === "r1" ? {
    run_id: "r1", state: "running", target_id: "t1", elapsed_sec: 120, last_event_seq: 5,
    evidence_root: "/tmp/runs/r1", artifact: { path: "/tmp/test.img", type: "firmware" },
    created_at: "2026-01-01T00:00:00Z",
  } : null,
  listNonTerminal: async () => [{ run_id: "r1", state: "running", target_id: "t1" }],
};

const mockEventStore = {
  read: async () => [
    { seq: 1, type: "run_started", summary: "started", payload: {}, time: "2026-01-01T00:00:00Z" },
    { seq: 2, type: "step_started", summary: "step 1", payload: {}, time: "2026-01-01T00:00:01Z", step_id: "s1" },
  ],
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
};

const mockMemoryStore = {
  listByTarget: async () => [{ episode_id: "e1", result: "completed", summary: "test" }],
};

describe("Views", () => {
  const views = new Views(mockRunStore, mockEventStore, mockEvidenceStore, mockTargetStore, mockMemoryStore);

  it("status returns run state", async () => {
    const s = await views.status("r1");
    expect(s?.state).toBe("running");
    expect(s?.elapsed_sec).toBe(120);
  });

  it("status returns null for unknown run", async () => {
    expect(await views.status("unknown")).toBeNull();
  });

  it("events returns paginated events", async () => {
    const result = await views.events("r1");
    expect(result.events).toHaveLength(2);
    expect(result.next_after_seq).toBe(2);
  });

  it("result for non-terminal run returns not-ready", async () => {
    const r = await views.result("r1");
    expect(r.result_available).toBe(false);
    expect(r.state).toBe("running");
  });

  it("evidence returns index", async () => {
    const ev = await views.evidence("r1");
    expect(ev.available).toBe(true);
    expect(ev.index?.refs).toHaveLength(1);
  });
});
