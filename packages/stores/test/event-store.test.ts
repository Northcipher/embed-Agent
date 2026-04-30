import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventStore, type AppendEvent } from "../src/event-store.js";

const ev = (t: string): AppendEvent => ({ type: t, source: "test", summary: "", payload: {} });

describe("EventStore", () => {
  const tmpDir = path.join(os.tmpdir(), `es-${Date.now()}`);
  const store = new EventStore(tmpDir);

  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("append assigns seq", async () => {
    expect((await store.append("r1", ev("a"))).seq).toBe(1);
    expect((await store.append("r1", ev("b"))).seq).toBe(2);
  });

  it("read returns EventRecord with seq and time", async () => {
    const events = await store.read("r1");
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(typeof e.seq).toBe("number");
      expect(typeof e.time).toBe("string");
      expect(e.seq).toBeGreaterThan(0);
    }
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

  it("concurrent appends get unique seqs", async () => {
    // Fire 10 concurrent appends — every seq must be unique
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.append("r-concurrent", ev(`c${i}`))),
    );
    const seqs = results.map(r => r.seq);
    const unique = new Set(seqs);
    expect(unique.size).toBe(10);
    // Seqs should be contiguous 1..10
    expect(Math.max(...seqs)).toBe(10);
  });

  it("rejects path traversal in runId", async () => {
    await expect(store.append("../escape", ev("x"))).rejects.toThrow("path characters");
    await expect(store.read("../escape")).rejects.toThrow("path characters");
  });

  it("rejects path separators in runId", async () => {
    await expect(store.append("a/b", ev("x"))).rejects.toThrow("path characters");
  });
});
