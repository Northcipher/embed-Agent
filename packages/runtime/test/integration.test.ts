/**
 * EVENT-FIRST INTEGRATION TEST
 *
 * Verifies the event-first contract:
 * 1. Events emitted via EventBus reach EventStore subscribers
 * 2. EventStore.subscribeToBus correctly routes run/global events
 * 3. Per-run events are ordered within their run_id
 * 4. Global events go to the global stream
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventBus } from "../src/event-bus.js";
import { EventStore } from "../../stores/src/event-store.js";
import { RunStore } from "../../stores/src/run-store.js";

describe("Event-first: EventBus → EventStore persistence", () => {
  const tmpDir = path.join(os.tmpdir(), `ef-${Date.now()}`);
  const eventStore = new EventStore(tmpDir);
  const runStore = new RunStore(tmpDir);
  const bus = new EventBus();

  // Wire EventBus → EventStore
  eventStore.subscribeToBus(bus, runStore);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("run events are persisted to runs/{id}/events.jsonl", async () => {
    await bus.emit({
      type: "run_started", run_id: "r-integration",
      source: "test", summary: "Run started", payload: {},
    });

    const events = await eventStore.read("r-integration");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("run_started");
    expect(events[0]!.run_id).toBe("r-integration");
  });

  it("global events are persisted to events.jsonl", async () => {
    await bus.emit({
      type: "target_state_changed", source: "test",
      summary: "Global event", payload: {},
    });

    const events = await eventStore.readGlobal();
    expect(events.some(e => e.type === "target_state_changed")).toBe(true);
  });

  it("events within same run are ordered by seq", async () => {
    const runId = "r-ordered";
    await bus.emit({ type: "step_started", run_id: runId, source: "test", summary: "first", payload: {} });
    await bus.emit({ type: "step_completed", run_id: runId, source: "test", summary: "second", payload: {} });

    const events = await eventStore.read(runId);
    const runEvents = events.filter(e => e.run_id === runId);
    expect(runEvents[0]!.type).toBe("step_started");
    expect(runEvents[1]!.type).toBe("step_completed");
    expect(runEvents[0]!.seq).toBeLessThan(runEvents[1]!.seq!);
  });

  it("lastEventSeq is updated after event persistence", async () => {
    // Create a run record first
    const runId = "r-seq-update";
    await runStore.create({
      run_id: runId, session_id: "s1", state: "planning", target_id: "t1",
      artifact: { path: "/x", type: "img" }, elapsed_sec: 0, last_event_seq: 0,
      evidence_root: `${tmpDir}/runs/${runId}`, created_at: new Date().toISOString(),
    });

    await bus.emit({ type: "step_started", run_id: runId, source: "test", summary: "e1", payload: {} });
    await bus.emit({ type: "step_completed", run_id: runId, source: "test", summary: "e2", payload: {} });

    const run = await runStore.get(runId);
    expect(run!.last_event_seq).toBeGreaterThanOrEqual(2);
  });
});
