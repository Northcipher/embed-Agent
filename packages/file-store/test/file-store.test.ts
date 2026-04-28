import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../src/index.js";

describe("FileStore", () => {
  let rootDir: string;
  let store: FileStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-file-store-"));
    store = new FileStore({
      rootDir,
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("initializes run files with empty event stream and evidence index", async () => {
    const run = await store.createRun({
      run_id: "run-001",
      request: { target: "board-01" }
    });

    expect(run.status).toBe("queued");
    expect(run.last_event_seq).toBe(0);

    const runJson = JSON.parse(await readFile(path.join(rootDir, "runs", "run-001", "run.json"), "utf8"));
    expect(runJson.run_id).toBe("run-001");

    const events = await readFile(path.join(rootDir, "runs", "run-001", "events.jsonl"), "utf8");
    expect(events).toBe("");

    const index = await store.readEvidenceIndex("run-001");
    expect(index.refs).toEqual([]);
    expect(index.root_path).toBe(path.join(rootDir, "runs", "run-001"));
  });

  it("appends events with monotonic sequence and reads by cursor", async () => {
    await store.createRun({ run_id: "run-001" });

    const first = await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:01+08:00",
      elapsed_sec: 1,
      type: "run_created",
      severity: "info",
      source: "run_manager",
      summary: "run created"
    });
    const second = await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:02+08:00",
      elapsed_sec: 2,
      type: "state_changed",
      severity: "info",
      source: "orchestrator",
      summary: "state changed"
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect((await store.readRun("run-001")).last_event_seq).toBe(2);

    const events = await store.readEvents("run-001", { afterSeq: 1 });
    expect(events.map(event => event.seq)).toEqual([2]);
  });

  it("filters events by type and limit", async () => {
    await store.createRun({ run_id: "run-001" });
    await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:01+08:00",
      elapsed_sec: 1,
      type: "run_created",
      severity: "info",
      source: "run_manager",
      summary: "run created"
    });
    await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:02+08:00",
      elapsed_sec: 2,
      type: "rule_matched",
      severity: "error",
      source: "rule_engine",
      summary: "panic matched"
    });

    const events = await store.readEvents("run-001", { types: ["rule_matched"], limit: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("rule_matched");
  });

  it("writes evidence content before adding the index ref", async () => {
    await store.createRun({ run_id: "run-001" });

    const index = await store.addEvidenceRef(
      "run-001",
      {
        ref: "serial:last-200-lines",
        kind: "window",
        path: "snapshots/serial-last-200-lines.log",
        available: true,
        bytes: 12,
        source_ref: "serial:full"
      },
      "panic window"
    );

    expect(index.refs.map(ref => ref.ref)).toEqual(["serial:last-200-lines"]);
    await expect(readFile(path.join(rootDir, "runs", "run-001", "snapshots", "serial-last-200-lines.log"), "utf8")).resolves.toBe(
      "panic window"
    );
  });

  it("keeps key events sorted and unique by sequence", async () => {
    await store.createRun({ run_id: "run-001" });

    await store.addKeyEvent("run-001", {
      seq: 42,
      summary: "old summary",
      evidence_refs: ["serial:last-200-lines"]
    });
    const index = await store.addKeyEvent("run-001", {
      seq: 42,
      summary: "new summary",
      evidence_refs: ["serial:last-200-lines"]
    });

    expect(index.key_events).toEqual([
      {
        seq: 42,
        summary: "new summary",
        evidence_refs: ["serial:last-200-lines"]
      }
    ]);
  });

  it("rejects evidence paths outside the run directory", async () => {
    await store.createRun({ run_id: "run-001" });

    await expect(
      store.addEvidenceRef("run-001", {
        ref: "bad",
        kind: "log",
        path: "../outside.log",
        available: true
      })
    ).rejects.toThrow("inside the run directory");

    await expect(
      store.addEvidenceRef("run-001", {
        ref: "bad",
        kind: "log",
        path: "/tmp/outside.log",
        available: true
      })
    ).rejects.toThrow("relative to the run directory");
  });
});
