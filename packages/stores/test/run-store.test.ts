import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RunStore, type RunRecord } from "../src/run-store.js";

const r = (id: string, state: RunRecord["state"]): RunRecord => ({
  run_id: id, session_id: "s1", state, target_id: "t1",
  artifact: { path: "/x", type: "img" }, elapsed_sec: 0, last_event_seq: 0,
  evidence_root: "/x", created_at: new Date().toISOString(),
});

describe("RunStore", () => {
  const d = path.join(os.tmpdir(), `rs-${Date.now()}`);
  const s = new RunStore(d);
  afterAll(async () => { await fs.rm(d, { recursive: true, force: true }); });

  it("create+get+update", async () => {
    await s.create(r("r1", "planning"));
    const g = await s.get("r1");
    expect(g!.state).toBe("planning");
    await s.update("r1", { state: "running" });
    expect((await s.get("r1"))!.state).toBe("running");
  });

  it("updateLastEventSeq", async () => {
    await s.updateLastEventSeq("r1", 42);
    expect((await s.get("r1"))!.last_event_seq).toBe(42);
  });

  it("listNonTerminal excludes completed", async () => {
    await s.create(r("r2", "running"));
    await s.create(r("r3", "completed"));
    const nt = await s.listNonTerminal();
    expect(nt.some(x => x.run_id === "r2")).toBe(true);
    expect(nt.some(x => x.run_id === "r3")).toBe(false);
  });

  it("get returns null for unknown", async () => {
    expect(await s.get("x")).toBeNull();
  });
});
