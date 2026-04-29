import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceStore } from "../src/evidence-store.js";

describe("EvidenceStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-ev-${Date.now()}`);
  const store = new EvidenceStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should write evidence and return path", async () => {
    const result = await store.write("run-001", "serial:full", "line1\nline2\n");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.filePath).toContain("serial.log");
  });

  it("should read evidence metadata", async () => {
    const meta = await store.read("run-001", "serial:full");
    expect(meta.available).toBe(true);
    expect(meta.size).toBeGreaterThan(0);
  });

  it("should return available=false for unknown ref", async () => {
    const meta = await store.read("run-001", "unknown:log");
    expect(meta.available).toBe(false);
  });

  it("should update index with refs", async () => {
    await store.write("run-002", "dmesg:full", "test");
    const index = await store.getIndex("run-002");
    expect(index.refs.length).toBeGreaterThanOrEqual(1);
    expect(index.refs.some(r => r.ref === "dmesg:full")).toBe(true);
  });

  it("should update key events", async () => {
    await store.updateKeyEvents("run-002", { seq: 1, summary: "kernel panic", evidence_refs: ["serial:last-280-lines"] });
    const index = await store.getIndex("run-002");
    expect(index.key_events.length).toBeGreaterThanOrEqual(1);
    expect(index.key_events[0].summary).toBe("kernel panic");
  });

  it("should return empty index for unknown run", async () => {
    const index = await store.getIndex("run-unknown");
    expect(index.refs).toHaveLength(0);
    expect(index.partial).toBe(true);
  });

  it("should write window evidence to snapshots dir", async () => {
    const result = await store.write("run-003", "serial:last-280-lines", "panic at line 342\n");
    expect(result.filePath).toContain("snapshots");
  });
});
