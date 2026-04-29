import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceCleanup } from "../src/evidence-cleanup.js";
import { RunStore } from "../src/run-store.js";
import type { RunRecord } from "@embed-agent/contracts";

describe("EvidenceCleanup lifecycle", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-cln2-${Date.now()}`);
  const runStore = new RunStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createRunWithEvidence(id: string, state: RunRecord["state"], daysAgo: number): Promise<void> {
    const date = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    const run: RunRecord = {
      run_id: id, session_id: "s1", state, target_id: "t1",
      artifact: { path: "/x", type: "img" },
      elapsed_sec: 0, last_event_seq: 0, evidence_root: `/runs/${id}`,
      created_at: date, ended_at: date,
    };
    await runStore.create(run);
    const runDir = path.join(tmpDir, "runs", id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "test.log"), "data");
  }

  it("should keep failed runs longer than successful ones", async () => {
    await createRunWithEvidence("run-old-success", "completed", 2); // > success_days=1
    await createRunWithEvidence("run-old-fail", "failed", 2);       // < failure_days=3

    const cleanup = new EvidenceCleanup(tmpDir, { success_days: 1, failure_days: 3 }, runStore);
    await cleanup.cleanup();

    expect(await runStore.get("run-old-success")).toBeNull(); // deleted
    expect(await runStore.get("run-old-fail")).not.toBeNull(); // kept
  });

  it("should keep important runs regardless of age", async () => {
    const date = new Date(Date.now() - 10 * 86400_000).toISOString();
    const run: RunRecord = {
      run_id: "run-important", session_id: "s1", state: "completed", target_id: "t1",
      artifact: { path: "/x", type: "img" },
      elapsed_sec: 0, last_event_seq: 0, evidence_root: "/runs/run-important",
      created_at: date, ended_at: date,
      failure_reason: "important",
    };
    await runStore.create(run);
    const runDir = path.join(tmpDir, "runs", "run-important");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "test.log"), "important data");

    const cleanup = new EvidenceCleanup(tmpDir, { success_days: 1, failure_days: 3 }, runStore);
    await cleanup.cleanup();

    expect(await runStore.get("run-important")).not.toBeNull(); // kept because important
  });
});
