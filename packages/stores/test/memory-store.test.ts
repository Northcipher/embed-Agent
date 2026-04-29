import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../src/memory-store.js";
import type { WorkingMemoryEntry, Episode, SemanticFact, RunProfile } from "@embed-agent/contracts";

describe("MemoryStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-mem-${Date.now()}`);
  const store = new MemoryStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read working memory", async () => {
    const entries: WorkingMemoryEntry[] = [
      { key: "panic_detected", summary: "kernel panic at 42s", source: "observer", at: new Date().toISOString() },
    ];
    await store.writeWorkingMemory("run-001", entries);
    const read = await store.readWorkingMemory("run-001");
    expect(read).toHaveLength(1);
    expect(read[0].key).toBe("panic_detected");
  });

  it("should return empty for unknown run working memory", async () => {
    const read = await store.readWorkingMemory("run-unknown");
    expect(read).toHaveLength(0);
  });

  it("should write and list episodes by target", async () => {
    const ep: Episode = {
      episode_id: "ep-1", run_id: "run-001", target_id: "board-01",
      artifact_ref: "boot.img v1.0", task: "validate boot",
      result: "failed", summary: "kernel panic", key_evidence: [],
      suggestions: ["check init"], pitfalls: [], recorded_at: new Date().toISOString(),
    };
    await store.writeEpisode(ep);
    const list = await store.listByTarget("board-01");
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].episode_id).toBe("ep-1");
  });

  it("should write, query, and confirm semantic facts", async () => {
    const fact: SemanticFact = {
      fact_id: "f-1", scope: "target", scope_id: "board-01",
      category: "known_issue", statement: "foo error is harmless",
      source: "auto", evidence_refs: [], verified: false,
      created_at: new Date().toISOString(),
    };
    await store.writeFact(fact);

    const results = await store.queryFacts("target", "board-01", "known_issue");
    expect(results.length).toBeGreaterThanOrEqual(1);

    await store.updateFact("f-1", { verified: true });
    const verified = await store.queryFacts("target", "board-01", "known_issue", true);
    expect(verified.length).toBeGreaterThanOrEqual(1);
    expect(verified[0].verified).toBe(true);
  });

  it("should write and retrieve run profile", async () => {
    const profile: RunProfile = {
      run_id: "run-001", target_id: "board-01",
      artifact: { path: "/boot.img", type: "firmware_img" },
      result: "failed",
      stage_durations: [{ stage: "kernel", duration: 12.8 }],
      final_metrics: { memory_mb: 120 },
      output_summary: { total_lines: 5000, peak_lines_per_sec: 200, silence_count: 1, rule_hits: { kernel_panic: 1 } },
      recorded_at: new Date().toISOString(),
    };
    await store.writeProfile(profile);

    const latest = await store.getLatestProfile("board-01");
    expect(latest).not.toBeNull();
    expect(latest!.run_id).toBe("run-001");
  });
});
