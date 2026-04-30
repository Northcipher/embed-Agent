import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceStore } from "../src/evidence-store.js";

describe("EvidenceStore", () => {
  const tmpDir = path.join(os.tmpdir(), `evs-${Date.now()}`);
  const store = new EvidenceStore(tmpDir);

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
});
