import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventStore } from "../src/event-store.js";
import type { Event } from "@embed-agent/contracts";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    seq: 0,
    run_id: "run-001",
    time: new Date().toISOString(),
    type: "run_started",
    source: "run_manager",
    summary: "test",
    payload: {},
    ...overrides,
  };
}

describe("EventStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-es-${Date.now()}`);
  const store = new EventStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should append and assign seq", async () => {
    const r1 = await store.append("run-001", makeEvent());
    expect(r1.seq).toBe(1);
    const r2 = await store.append("run-001", makeEvent());
    expect(r2.seq).toBe(2);
  });

  it("should read events with afterSeq cursor", async () => {
    const events = await store.read("run-001", 0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].seq).toBeGreaterThan(0);
  });

  it("should read events after a specific seq", async () => {
    const events = await store.read("run-001", 1);
    expect(events.every(e => e.seq > 1)).toBe(true);
  });

  it("should return empty for unknown run", async () => {
    const events = await store.read("run-unknown");
    expect(events).toHaveLength(0);
  });

  it("should append and read global events", async () => {
    const r1 = await store.appendGlobal(makeEvent({ run_id: undefined }));
    expect(r1.seq).toBe(1);
    const events = await store.readGlobal(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("should isolate run events from global events", async () => {
    await store.append("run-002", makeEvent({ run_id: "run-002" }));
    const runEvents = await store.read("run-002");
    expect(runEvents.length).toBeGreaterThanOrEqual(1);
    expect(runEvents.every(e => e.run_id === "run-002")).toBe(true);
  });
});
