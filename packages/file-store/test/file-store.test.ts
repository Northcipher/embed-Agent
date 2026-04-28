import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("reads the persisted run request when one was stored", async () => {
    await store.createRun({
      run_id: "run-001",
      request: {
        context: {
          task: "verify boot",
          expected: "device boots"
        },
        target: "board-01"
      }
    });
    await store.createRun({ run_id: "run-002" });

    await expect(store.readRunRequest("run-001")).resolves.toMatchObject({
      context: {
        task: "verify boot",
        expected: "device boots"
      },
      target: "board-01"
    });
    await expect(store.readRunRequest("run-002")).resolves.toBeUndefined();
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

  it("serializes concurrent run event and status writes", async () => {
    await store.createRun({ run_id: "run-001", status: "paused" });
    const initialRun = await store.readRun("run-001");

    await Promise.all([
      store.appendEvent("run-001", {
        time: "2026-04-28T10:00:01+08:00",
        elapsed_sec: 1,
        type: "step_completed",
        severity: "info",
        source: "tool_adapter",
        step_id: "step-one",
        summary: "step one completed"
      }),
      store.writeRun({
        ...initialRun,
        status: "cancelled"
      }),
      store.appendEvent("run-001", {
        time: "2026-04-28T10:00:02+08:00",
        elapsed_sec: 2,
        type: "run_cancelled",
        severity: "warning",
        source: "run_manager",
        summary: "run cancelled"
      })
    ]);

    const run = await store.readRun("run-001");
    const events = await store.readEvents("run-001");
    expect(run.status).toBe("cancelled");
    expect(run.last_event_seq).toBe(2);
    expect(events.map(event => event.seq)).toEqual([1, 2]);
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

  it("tolerates an incomplete trailing JSONL line while reading events", async () => {
    await store.createRun({ run_id: "run-001" });

    const first = await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:01+08:00",
      elapsed_sec: 1,
      type: "run_created",
      severity: "info",
      source: "run_manager",
      summary: "run created"
    });

    const eventsPath = path.join(rootDir, "runs", "run-001", "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify(first)}\n{\"incomplete\":`, "utf8");

    await expect(store.readEvents("run-001")).resolves.toEqual([first]);
  });

  it("throws when events.jsonl contains invalid JSON and ends with newline", async () => {
    await store.createRun({ run_id: "run-001" });

    const first = await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:01+08:00",
      elapsed_sec: 1,
      type: "run_created",
      severity: "info",
      source: "run_manager",
      summary: "run created"
    });

    const eventsPath = path.join(rootDir, "runs", "run-001", "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify(first)}\n{bad}\n`, "utf8");

    await expect(store.readEvents("run-001")).rejects.toThrow("Invalid events.jsonl line");
  });

  it("throws on a non-final invalid JSONL line even when the file lacks trailing newline", async () => {
    await store.createRun({ run_id: "run-001" });

    const first = await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:01+08:00",
      elapsed_sec: 1,
      type: "run_created",
      severity: "info",
      source: "run_manager",
      summary: "run created"
    });
    const second = {
      ...first,
      seq: 2,
      type: "state_changed",
      summary: "state changed"
    };

    const eventsPath = path.join(rootDir, "runs", "run-001", "events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify(first)}\n{bad}\n${JSON.stringify(second)}`, "utf8");

    await expect(store.readEvents("run-001")).rejects.toThrow("Invalid events.jsonl line");
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

  it("promotes critical events with evidence refs into the evidence index key events", async () => {
    await store.createRun({ run_id: "run-001" });

    await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:01+08:00",
      elapsed_sec: 1,
      type: "rule_matched",
      severity: "error",
      source: "rule_engine",
      summary: "kernel panic matched on serial",
      evidence_refs: ["serial:last-200-lines"]
    });
    await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:02+08:00",
      elapsed_sec: 2,
      type: "evidence_collected",
      severity: "info",
      source: "evidence_store",
      summary: "serial log collected",
      evidence_refs: ["serial:full"]
    });
    await store.appendEvent("run-001", {
      time: "2026-04-28T10:00:03+08:00",
      elapsed_sec: 3,
      type: "step_failed",
      severity: "warning",
      source: "tool_adapter",
      summary: "smoke test failed",
      evidence_refs: ["adb:step-smoke"]
    });

    const index = await store.readEvidenceIndex("run-001");
    expect(index.key_events).toEqual([
      {
        seq: 1,
        summary: "kernel panic matched on serial",
        evidence_refs: ["serial:last-200-lines"]
      },
      {
        seq: 3,
        summary: "smoke test failed",
        evidence_refs: ["adb:step-smoke"]
      }
    ]);
  });

  it("writes and reads validated agent replies", async () => {
    await store.createRun({ run_id: "run-001" });

    expect(await store.readAgentReply("run-001")).toBeUndefined();
    const reply = await store.writeAgentReply("run-001", {
      run_id: "run-001",
      status: "completed",
      summary: "run completed; review evidence refs",
      confidence: 0.5,
      key_evidence: [],
      suggested_next: "review evidence refs if more detail is needed",
      evidence_path: path.join(rootDir, "runs", "run-001")
    });

    expect(reply.status).toBe("completed");
    await expect(readFile(path.join(rootDir, "runs", "run-001", "reply.json"), "utf8")).resolves.toContain("run completed");
    await expect(store.readAgentReply("run-001")).resolves.toMatchObject({
      run_id: "run-001",
      status: "completed"
    });
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

  it("rejects run ids that would escape the runs directory", async () => {
    await expect(store.createRun({ run_id: ".." })).rejects.toThrow("run_id contains unsupported characters");
    await expect(store.createRun({ run_id: "." })).rejects.toThrow("run_id contains unsupported characters");
    await expect(store.createRun({ run_id: "run.001" })).rejects.toThrow("run_id contains unsupported characters");
  });
});
