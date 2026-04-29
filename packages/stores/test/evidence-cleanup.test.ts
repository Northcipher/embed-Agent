import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceCleanup } from "../src/evidence-cleanup.js";
import { RunStore } from "../src/run-store.js";
import type { RunRecord } from "@embed-agent/contracts";

describe("EvidenceCleanup", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-cln-${Date.now()}`);
  const runStore = new RunStore(tmpDir);
  const cleanup = new EvidenceCleanup(tmpDir, { success_days: 1, failure_days: 3 }, runStore);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should not delete recent runs", async () => {
    const run: RunRecord = {
      run_id: "run-recent", session_id: "s1", state: "completed",
      target_id: "t1", artifact: { path: "/x", type: "img" },
      elapsed_sec: 0, last_event_seq: 0, evidence_root: "/x",
      created_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    };
    await runStore.create(run);
    // Create a file in the run dir
    const runDir = path.join(tmpDir, "runs", "run-recent");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "test.log"), "data");

    const freed = await cleanup.cleanup();
    expect(freed).toBe(0); // should not delete recent run
  });

  it("should delete old successful runs", async () => {
    const oldDate = new Date(Date.now() - 2 * 86400_000).toISOString();
    const run: RunRecord = {
      run_id: "run-old", session_id: "s1", state: "completed",
      target_id: "t1", artifact: { path: "/x", type: "img" },
      elapsed_sec: 0, last_event_seq: 0, evidence_root: "/x",
      created_at: oldDate, ended_at: oldDate,
    };
    await runStore.create(run);
    const runDir = path.join(tmpDir, "runs", "run-old");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "test.log"), "old data");

    const freed = await cleanup.cleanup();
    expect(freed).toBeGreaterThan(0);
  });
});
