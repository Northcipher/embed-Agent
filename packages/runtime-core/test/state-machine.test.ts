import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "@artifact-validation/file-store";
import { allowedNextRunStates, canTransitionRunState, isTerminalRunState, RunManager } from "../src/index.js";

describe("runtime state machine", () => {
  it("encodes allowed P0 transitions", () => {
    expect(canTransitionRunState("queued", "planning")).toBe(true);
    expect(canTransitionRunState("planning", "running")).toBe(true);
    expect(canTransitionRunState("running", "paused")).toBe(true);
    expect(canTransitionRunState("paused", "running")).toBe(true);
    expect(canTransitionRunState("running", "collecting_evidence")).toBe(true);
    expect(canTransitionRunState("collecting_evidence", "completed")).toBe(true);
    expect(canTransitionRunState("completed", "running")).toBe(false);
    expect(isTerminalRunState("failed")).toBe(true);
    expect(allowedNextRunStates("cancelled")).toEqual([]);
  });
});

describe("RunManager", () => {
  let rootDir: string;
  let store: FileStore;
  let manager: RunManager;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-runtime-core-"));
    const now = () => new Date("2026-04-28T02:00:00.000Z");
    store = new FileStore({ rootDir, now });
    manager = new RunManager({ store, now });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates a queued run and appends run_created", async () => {
    const result = await manager.createRun({ runId: "run-001" });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("queued");
    expect(result.event.type).toBe("run_created");
    expect((await store.readEvents("run-001")).map(event => event.type)).toEqual(["run_created"]);
  });

  it("rejects invalid initial run states", async () => {
    const result = await manager.createRun({ runId: "run-001", initialState: "running" });

    expect(result).toEqual({
      accepted: false,
      error_code: "invalid_request",
      message: "initial state running is not allowed"
    });
  });

  it("persists valid transitions and writes state_changed events", async () => {
    await manager.createRun({ runId: "run-001", initialState: "planning" });

    const result = await manager.transitionRun({
      runId: "run-001",
      to: "running",
      reason: "plan accepted",
      source: "orchestrator"
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("running");
    expect(result.events.map(event => event.type)).toEqual(["state_changed"]);
    expect((await store.readEvents("run-001")).map(event => event.type)).toEqual(["run_created", "state_changed"]);
  });

  it("rejects invalid transitions without writing events", async () => {
    await manager.createRun({ runId: "run-001", initialState: "queued" });

    const result = await manager.transitionRun({
      runId: "run-001",
      to: "running",
      reason: "skip planning"
    });

    expect(result).toEqual({
      accepted: false,
      error_code: "invalid_request",
      message: "cannot transition run run-001 from queued to running"
    });
    expect((await store.readRun("run-001")).status).toBe("queued");
    expect((await store.readEvents("run-001")).map(event => event.type)).toEqual(["run_created"]);
  });

  it("appends terminal events when entering terminal states", async () => {
    await manager.createRun({ runId: "run-001", initialState: "planning" });
    await manager.transitionRun({ runId: "run-001", to: "running", reason: "plan accepted" });
    await manager.transitionRun({ runId: "run-001", to: "collecting_evidence", reason: "main path done" });

    const result = await manager.transitionRun({
      runId: "run-001",
      to: "completed",
      reason: "reply written"
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.events.map(event => event.type)).toEqual(["state_changed", "run_completed"]);
    expect((await store.readRun("run-001")).status).toBe("completed");
  });

  it("does not transition out of terminal states", async () => {
    await manager.createRun({ runId: "run-001", initialState: "planning" });
    await manager.transitionRun({ runId: "run-001", to: "failed", reason: "planner failed" });

    const result = await manager.transitionRun({
      runId: "run-001",
      to: "running",
      reason: "retry"
    });

    expect(result.accepted).toBe(false);
    expect((await store.readRun("run-001")).status).toBe("failed");
  });
});
