import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityName } from "@artifact-validation/contracts";
import { FileStore } from "@artifact-validation/file-store";
import { FakeAdapterRegistry, FakeCapabilityAdapter } from "../src/index.js";

describe("FakeCapabilityAdapter", () => {
  let rootDir: string;
  let store: FileStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-fake-adapters-"));
    store = new FileStore({
      rootDir,
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });
    await store.createRun({ run_id: "run-001" });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("supports every P0 capability through the fake registry", () => {
    const registry = new FakeAdapterRegistry();

    const capabilities: CapabilityName[] = [
      "flash",
      "push",
      "watch_serial",
      "wait_adb",
      "shell_exec",
      "check_process",
      "collect_logs",
      "save_snapshot"
    ];
    expect(capabilities.every(capability => registry.get(capability) !== undefined)).toBe(true);
  });

  it("writes serial evidence and reports matched patterns", async () => {
    const adapter = new FakeCapabilityAdapter("watch_serial", {
      serialOutput: ["Booting Linux", "kernel panic", "rebooting"]
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: {
        id: "step-serial",
        capability: "watch_serial",
        condition: "always",
        input: {
          duration_sec: 10,
          patterns: ["kernel panic", "boot completed"]
        },
        timeout_sec: 10
      }
    });

    expect(result.success).toBe(true);
    expect(result.output.patterns_matched).toEqual(["kernel panic"]);
    expect((await store.readEvidenceIndex("run-001")).refs.map(ref => ref.ref)).toContain("serial:full");
    await expect(readFile(path.join(rootDir, "runs", "run-001", "serial.log"), "utf8")).resolves.toContain("kernel panic");
  });

  it("writes shell_exec output and fails on unexpected exit code", async () => {
    const adapter = new FakeCapabilityAdapter("shell_exec", {
      commandResults: {
        "/vendor/bin/smoke_test": {
          exit_code: 2,
          stdout: "bad\n",
          stderr: "failed\n"
        }
      }
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: {
        id: "step-smoke",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/smoke_test",
          expected_exit_code: 0
        },
        timeout_sec: 60
      }
    });

    expect(result.success).toBe(false);
    expect(result.output.exit_code).toBe(2);
    expect((await store.readEvidenceIndex("run-001")).refs.map(ref => ref.ref)).toContain("adb:step-smoke");
  });

  it("collects configured fake logs and reports missing items", async () => {
    const adapter = new FakeCapabilityAdapter("collect_logs", {
      logs: {
        dmesg: "fake dmesg\n"
      }
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: {
        id: "step-logs",
        capability: "collect_logs",
        condition: "on_failure",
        input: {
          items: ["dmesg", "logcat"]
        },
        timeout_sec: 60
      }
    });

    expect(result.output).toEqual({
      log_refs: ["log:dmesg"],
      missing_items: ["logcat"]
    });
    await expect(readFile(path.join(rootDir, "runs", "run-001", "logs", "dmesg.log"), "utf8")).resolves.toBe("fake dmesg\n");
  });

  it("writes snapshots through evidence store", async () => {
    const adapter = new FakeCapabilityAdapter("save_snapshot");

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: {
        id: "snapshot-1",
        capability: "save_snapshot",
        condition: "on_failure",
        input: {
          reason: "panic",
          include: ["serial:full"]
        },
        timeout_sec: 30
      }
    });

    expect(result.output.snapshot_ref).toBe("snapshot:snapshot-1");
    await expect(readFile(path.join(rootDir, "runs", "run-001", "snapshots", "snapshot-1.json"), "utf8")).resolves.toContain(
      "\"reason\": \"panic\""
    );
    expect((await store.readEvidenceIndex("run-001")).refs[0]?.kind).toBe("snapshot");
  });

  it("does not let an adapter execute a mismatched capability", async () => {
    const adapter = new FakeCapabilityAdapter("wait_adb");

    await expect(
      adapter.execute({
        runId: "run-001",
        store,
        step: {
          id: "step-serial",
          capability: "watch_serial",
          condition: "always",
          input: {},
          timeout_sec: 10
        }
      })
    ).rejects.toThrow("cannot execute step capability");
  });

  it("rejects unsafe step ids before building evidence paths", async () => {
    const adapter = new FakeCapabilityAdapter("save_snapshot");

    await expect(
      adapter.execute({
        runId: "run-001",
        store,
        step: {
          id: "../snapshot",
          capability: "save_snapshot",
          condition: "on_failure",
          input: {
            reason: "panic"
          },
          timeout_sec: 30
        }
      })
    ).rejects.toThrow("not safe for an evidence path segment");
  });
});
