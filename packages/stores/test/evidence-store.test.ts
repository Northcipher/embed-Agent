import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceStore } from "../src/evidence-store.js";

describe("EvidenceStore", () => {
  const tmpDir = path.join(os.tmpdir(), `evs-${Date.now()}`);
  const events: Record<string, unknown>[] = [];
  const store = new EvidenceStore(tmpDir, { emit: e => events.push(e) });

  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("write + read", async () => {
    const r = await store.write("r1", "serial:full", "hello\n");
    expect(r.bytes).toBeGreaterThan(0);
    const meta = await store.read("r1", "serial:full");
    expect(meta.available).toBe(true);
  });

  it("window ref goes to snapshots", async () => {
    const r = await store.write("r2", "serial:last-280-lines", "panic\n");
    expect(r.filePath).toContain("snapshots");
  });

  it("index tracks refs", async () => {
    await store.write("r3", "dmesg:full", "ok");
    const idx = await store.getIndex("r3");
    expect(idx.refs.some(r => r.ref === "dmesg:full")).toBe(true);
  });

  it("key events updated", async () => {
    await store.updateKeyEvents("r3", { seq: 1, summary: "panic", evidence_refs: ["serial:last-280-lines"] });
    const idx = await store.getIndex("r3");
    expect(idx.key_events.length).toBeGreaterThanOrEqual(1);
  });

  it("unknown ref returns not available", async () => {
    const meta = await store.read("rx", "x:full");
    expect(meta.available).toBe(false);
  });

  it("emits evidence_collected on write", async () => {
    const before = events.length;
    await store.write("r4", "logcat:full", "log data");
    const newEvents = events.slice(before);
    expect(newEvents.some(e => e.type === "evidence_collected")).toBe(true);
    const ev = newEvents.find(e => e.type === "evidence_collected")!;
    expect(ev.run_id).toBe("r4");
    expect((ev.payload as Record<string, unknown>).ref).toBe("logcat:full");
  });

  it("rejects path traversal in runId", async () => {
    await expect(store.write("../escape", "x:full", "data")).rejects.toThrow("path characters");
    await expect(store.read("../escape", "x:full")).rejects.toThrow("path characters");
    await expect(store.getIndex("../escape")).rejects.toThrow("path characters");
  });

  it("rejects path traversal in ref", async () => {
    await expect(store.write("r1", "../../targets/profile", "data")).rejects.toThrow("path characters");
    await expect(store.read("r1", "../etc/passwd")).rejects.toThrow("path characters");
  });

  it("getIndex returns empty for missing run (ENOENT)", async () => {
    const idx = await store.getIndex("nonexistent");
    expect(idx.partial).toBe(true);
    expect(idx.refs).toHaveLength(0);
  });

  it("getIndex throws on corrupted index", async () => {
    // Write garbage to the index file directly
    const dir = path.join(tmpDir, "runs", "r-corrupt");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "evidence-index.json"), "not valid json {{{", "utf-8");

    await expect(store.getIndex("r-corrupt")).rejects.toThrow("Corrupted evidence index");
  });

  it("concurrent addRef does not lose entries", async () => {
    // Fire 10 concurrent writes — all refs should appear in the index
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.write("r-concurrent", `test:ref${i}`, `data${i}`)),
    );
    const idx = await store.getIndex("r-concurrent");
    const testRefs = idx.refs.filter(r => r.ref.startsWith("test:ref"));
    expect(testRefs).toHaveLength(10);
  });
});
