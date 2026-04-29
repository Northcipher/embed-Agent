import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RunStore } from "../src/run-store.js";
import type { RunRecord } from "@embed-agent/contracts";

function makeRun(id: string, state: RunRecord["state"]): RunRecord {
  return {
    run_id: id, session_id: "s1", state, target_id: "t1",
    artifact: { path: "/x", type: "img" },
    elapsed_sec: 0, last_event_seq: 0, evidence_root: "/x",
    created_at: new Date().toISOString(),
  };
}

describe("RunStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-rs-${Date.now()}`);
  const store = new RunStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create and get a run", async () => {
    await store.create(makeRun("run-001", "planning"));
    const run = await store.get("run-001");
    expect(run).not.toBeNull();
    expect(run!.state).toBe("planning");
  });

  it("should update run state", async () => {
    await store.update("run-001", { state: "running" });
    const run = await store.get("run-001");
    expect(run!.state).toBe("running");
  });

  it("should update last event seq", async () => {
    await store.updateLastEventSeq("run-001", 42);
    const run = await store.get("run-001");
    expect(run!.last_event_seq).toBe(42);
  });

  it("should list non-terminal runs only", async () => {
    await store.create(makeRun("run-002", "running"));
    await store.create(makeRun("run-003", "completed"));
    await store.create(makeRun("run-004", "finalizing"));
    const nonTerminal = await store.listNonTerminal();
    const ids = nonTerminal.map(r => r.run_id);
    expect(ids).toContain("run-002");
    expect(ids).toContain("run-004");
    expect(ids).not.toContain("run-003");
  });

  it("should return null for unknown run", async () => {
    const run = await store.get("run-unknown");
    expect(run).toBeNull();
  });
});
