import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryStore, RunCleanupStore, RunStore, type Episode, type RunRecord, type RunProfile } from "../src/index.js";

const tmpDir = path.join(os.tmpdir(), `run-cleanup-${Date.now()}`);

function run(id: string, state: RunRecord["state"]): RunRecord {
  return {
    run_id: id,
    session_id: "s1",
    state,
    target_id: "t1",
    artifact: { path: "/tmp/a.bin", type: "firmware" },
    elapsed_sec: 1,
    last_event_seq: 1,
    evidence_root: path.join(tmpDir, "runs", id),
    created_at: "2026-01-01T00:00:00Z",
  };
}

function episode(runId: string): Episode {
  return {
    episode_id: `ep-${runId}`,
    run_id: runId,
    target_id: "t1",
    artifact_ref: "/tmp/a.bin",
    task: "test",
    result: "completed",
    summary: "done",
    key_evidence: [],
    suggestions: [],
    pitfalls: [],
    recorded_at: "2026-01-01T00:00:00Z",
  };
}

function profile(runId: string): RunProfile {
  return {
    run_id: runId,
    target_id: "t1",
    artifact: { path: "/tmp/a.bin", type: "firmware" },
    result: "completed",
    stage_durations: [],
    final_metrics: {},
    output_summary: { total_lines: 1, peak_lines_per_sec: 1, silence_count: 0, rule_hits: {} },
    recorded_at: "2026-01-01T00:00:00Z",
  };
}

describe("RunCleanupStore", () => {
  const runs = new RunStore(tmpDir);
  const memory = new MemoryStore(tmpDir);
  const cleanup = new RunCleanupStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes terminal run files and related memory", async () => {
    await runs.create(run("run-done", "completed"));
    await fs.writeFile(path.join(tmpDir, "runs", "run-done", "events.jsonl"), "{\"seq\":1}\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "runs", "run-done", "step-s1-full.log"), "ok\n", "utf-8");
    await memory.writeWorkingMemory("run-done", [{ key: "k", summary: "v", source: "observer", at: "2026-01-01T00:00:00Z" }]);
    await memory.writeEpisode(episode("run-done"));
    await memory.writeProfile(profile("run-done"));

    const result = await cleanup.deleteRun("run-done");

    expect(result).toEqual({ status: "deleted", run_id: "run-done" });
    await expect(fs.stat(path.join(tmpDir, "runs", "run-done"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await memory.readWorkingMemory("run-done")).toEqual([]);
    expect(await memory.getLatestProfile("t1")).toBeNull();
    expect(await memory.listByTarget("t1")).toEqual([]);
  });

  it("refuses to delete non-terminal runs", async () => {
    await runs.create(run("run-active", "running"));

    const result = await cleanup.deleteRun("run-active");

    expect(result).toEqual({ status: "run_active", run_id: "run-active", state: "running" });
    expect(await runs.get("run-active")).not.toBeNull();
  });
});
