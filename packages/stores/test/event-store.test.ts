import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventStore, type EventRecord } from "../src/event-store.js";

const ev = (t: string): EventRecord => ({ type: t, source: "test", summary: "", payload: {} });

describe("EventStore", () => {
  const tmpDir = path.join(os.tmpdir(), `es-${Date.now()}`);
  const store = new EventStore(tmpDir);

  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("append assigns seq", async () => {
    expect((await store.append("r1", ev("a"))).seq).toBe(1);
    expect((await store.append("r1", ev("b"))).seq).toBe(2);
  });

  it("read with afterSeq", async () => {
    const events = await store.read("r1", 1);
    expect(events.every(e => e.seq > 1)).toBe(true);
  });

  it("empty for unknown run", async () => {
    expect(await store.read("x")).toHaveLength(0);
  });

  it("global events isolated", async () => {
    await store.appendGlobal(ev("g1"));
    expect((await store.readGlobal()).length).toBeGreaterThanOrEqual(1);
  });
});
