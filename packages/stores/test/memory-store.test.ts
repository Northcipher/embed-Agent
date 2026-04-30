import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryStore, type WorkingMemoryEntry, type Episode, type SemanticFact, type RunProfile } from "../src/memory-store.js";

describe("MemoryStore", () => {
  const d = path.join(os.tmpdir(), `ms-${Date.now()}`);
  const s = new MemoryStore(d);
  afterAll(async () => { await fs.rm(d, { recursive: true, force: true }); });

  it("write/read working memory", async () => {
    await s.writeWorkingMemory("r1", [{ key: "k", summary: "v", source: "observer", at: new Date().toISOString() }]);
    expect((await s.readWorkingMemory("r1")).length).toBe(1);
  });

  it("write/list episodes", async () => {
    await s.writeEpisode({ episode_id: "e1", run_id: "r1", target_id: "t1", artifact_ref: "", task: "", result: "failed", summary: "panic", key_evidence: [], suggestions: [], pitfalls: [], recorded_at: new Date().toISOString() });
    expect((await s.listByTarget("t1")).length).toBeGreaterThanOrEqual(1);
  });

  it("write/query/delete fact", async () => {
    const f: SemanticFact = { fact_id: "f1", scope: "target", scope_id: "t1", category: "known_issue", statement: "foo", source: "auto", evidence_refs: [], verified: false, created_at: new Date().toISOString() };
    await s.writeFact(f);
    expect((await s.queryFacts("target", "t1")).length).toBeGreaterThanOrEqual(1);

    await s.deleteFact("f1");
    expect((await s.queryFacts("target", "t1")).length).toBe(0); // tombstone excluded
  });

  it("getLatestProfile sorted by time", async () => {
    const p1: RunProfile = { run_id: "r1", target_id: "t1", artifact: { path: "", type: "" }, result: "completed", stage_durations: [], final_metrics: {}, output_summary: { total_lines: 0, peak_lines_per_sec: 0, silence_count: 0, rule_hits: {} }, recorded_at: "2026-01-01T00:00:00Z" };
    const p2: RunProfile = { ...p1, run_id: "r2", recorded_at: "2026-06-01T00:00:00Z" };
    await s.writeProfile(p1);
    await s.writeProfile(p2);
    const latest = await s.getLatestProfile("t1");
    expect(latest!.run_id).toBe("r2");
  });
});
