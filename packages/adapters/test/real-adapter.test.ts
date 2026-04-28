import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "@artifact-validation/file-store";
import type { PlanStep } from "@artifact-validation/contracts";
import {
  AdbAdapter,
  FlashAdapter,
  RealAdapterRegistry,
  SerialAdapter,
  SpawnCommandRunner,
  type CommandInvocation,
  type CommandRunResult,
  type CommandRunner,
  type SerialReader
} from "../src/index.js";

class RecordingRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];

  constructor(private readonly results: CommandRunResult[]) {}

  async run(invocation: CommandInvocation): Promise<CommandRunResult> {
    this.invocations.push(invocation);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`No recorded result for ${invocation.file} ${invocation.args.join(" ")}`);
    }
    return result;
  }
}

class FixedSerialReader implements SerialReader {
  constructor(private readonly content: string) {}

  async read(): Promise<{ content: string; disconnected: boolean }> {
    return { content: this.content, disconnected: false };
  }
}

class ErrorSerialReader implements SerialReader {
  async read(): Promise<{ content: string; disconnected: boolean; error?: string }> {
    return { content: "partial boot log\n", disconnected: true, error: "port lost" };
  }
}

describe("real adapters", () => {
  let rootDir: string;
  let store: FileStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-real-adapters-"));
    store = new FileStore({
      rootDir,
      now: () => new Date("2026-04-28T03:00:00.000Z")
    });
    await store.createRun({ run_id: "run-001" });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("executes adb shell through argv and writes command output evidence", async () => {
    const runner = new RecordingRunner([
      commandResult({
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationSec: 0.2
      })
    ]);
    const adapter = new AdbAdapter("shell_exec", {
      deviceId: "device-123",
      runner
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: step("step-smoke", "shell_exec", {
        command: "/vendor/bin/smoke_test",
        expected_exit_code: 0,
        timeout_sec: 30
      })
    });

    expect(runner.invocations[0]).toMatchObject({
      file: "adb",
      args: ["-s", "device-123", "shell", "/vendor/bin/smoke_test"],
      timeoutSec: 30
    });
    expect(result.success).toBe(true);
    expect(result.evidence_refs).toEqual(["adb:step-smoke"]);
    await expect(readFile(path.join(rootDir, "runs", "run-001", "adb-step-smoke.json"), "utf8")).resolves.toContain(
      "\"exit_code\": 0"
    );
  });

  it("returns timeout status when wait_adb never sees a device state", async () => {
    const runner = new RecordingRunner([
      commandResult({
        stdout: "offline\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationSec: 0.1
      })
    ]);
    const adapter = new AdbAdapter("wait_adb", {
      deviceId: "device-123",
      runner,
      waitPollIntervalMs: 1
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: step("step-adb", "wait_adb", { timeout_sec: 0 })
    });

    expect(runner.invocations[0]?.args).toEqual(["-s", "device-123", "get-state"]);
    expect(result.status).toBe("timeout");
    expect(result.success).toBe(false);
  });

  it("builds fastboot flash argv from adapter config and writes flash log evidence", async () => {
    const runner = new RecordingRunner([
      commandResult({
        stdout: "flashing ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationSec: 1.1
      })
    ]);
    const adapter = new FlashAdapter({
      method: "fastboot",
      deviceId: "fastboot-01",
      partition: "boot",
      artifactType: "boot_img",
      runner
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: step("step-flash", "flash", {
        artifact_ref: "/tmp/boot.img",
        artifact_type: "boot_img"
      })
    });

    expect(runner.invocations[0]).toMatchObject({
      file: "fastboot",
      args: ["-s", "fastboot-01", "flash", "boot", "/tmp/boot.img"]
    });
    expect(result.success).toBe(true);
    expect(result.output.flash_log_ref).toBe("flash:log");
    await expect(readFile(path.join(rootDir, "runs", "run-001", "flash.log"), "utf8")).resolves.toContain("flashing ok");
  });

  it("uses only allowlisted custom flash argv from adapter config", async () => {
    const runner = new RecordingRunner([
      commandResult({
        stdout: "custom ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationSec: 1
      })
    ]);
    const adapter = new FlashAdapter({
      method: "custom_command",
      command: {
        file: "vendor-flash",
        args: ["--image", "{artifact_ref}", "--type", "{artifact_type}"]
      },
      runner
    });

    await adapter.execute({
      runId: "run-001",
      store,
      step: step("step-custom-flash", "flash", {
        artifact_ref: "/tmp/firmware.bin",
        artifact_type: "firmware_img",
        command: "rm -rf /"
      })
    });

    expect(runner.invocations[0]).toMatchObject({
      file: "vendor-flash",
      args: ["--image", "/tmp/firmware.bin", "--type", "firmware_img"]
    });
  });

  it("rejects unsafe custom flash executable paths", async () => {
    const adapter = new FlashAdapter({
      method: "custom_command",
      command: {
        file: "../vendor-flash",
        args: ["{artifact_ref}"]
      },
      runner: new RecordingRunner([])
    });

    await expect(
      adapter.execute({
        runId: "run-001",
        store,
        step: step("step-unsafe-flash", "flash", {
          artifact_ref: "/tmp/firmware.bin",
          artifact_type: "firmware_img"
        })
      })
    ).rejects.toThrow("configured executable file");
  });

  it("rejects unresolved relative artifact paths before flashing", async () => {
    const adapter = new FlashAdapter({
      method: "fastboot",
      partition: "boot",
      runner: new RecordingRunner([])
    });

    await expect(
      adapter.execute({
        runId: "run-001",
        store,
        step: step("step-relative-artifact", "flash", {
          artifact_ref: "../firmware.bin",
          artifact_type: "firmware_img"
        })
      })
    ).rejects.toThrow("artifact_ref");
  });

  it("reads serial output through an injected reader and writes serial evidence", async () => {
    const adapter = new SerialAdapter({
      port: "/dev/ttyUSB0",
      baudRate: 115200,
      reader: new FixedSerialReader("Booting Linux\nkernel panic\n")
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: step("step-serial", "watch_serial", {
        duration_sec: 5,
        patterns: ["kernel panic", "boot completed"]
      })
    });

    expect(result.output.patterns_matched).toEqual(["kernel panic"]);
    expect(result.evidence_refs).toEqual(["serial:full"]);
    await expect(readFile(path.join(rootDir, "runs", "run-001", "serial.log"), "utf8")).resolves.toContain("kernel panic");
  });

  it("surfaces serial reader errors in adapter output", async () => {
    const adapter = new SerialAdapter({
      port: "/dev/ttyUSB0",
      baudRate: 115200,
      reader: new ErrorSerialReader()
    });

    const result = await adapter.execute({
      runId: "run-001",
      store,
      step: step("step-serial-error", "watch_serial", {
        duration_sec: 5,
        patterns: []
      })
    });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("serial read error");
    expect(result.output.error).toBe("port lost");
  });

  it("rejects shell metacharacters unless explicitly allowed by adapter config", async () => {
    const runner = new RecordingRunner([]);
    const adapter = new AdbAdapter("shell_exec", {
      deviceId: "device-123",
      runner
    });

    await expect(
      adapter.execute({
        runId: "run-001",
        store,
        step: step("step-dangerous-shell", "shell_exec", {
          command: "/vendor/bin/smoke_test; rm -rf /data",
          expected_exit_code: 0
        })
      })
    ).rejects.toThrow("shell metacharacters");
    expect(runner.invocations).toEqual([]);
  });

  it("rejects unsafe push destinations before running adb", async () => {
    const runner = new RecordingRunner([]);
    const adapter = new AdbAdapter("push", {
      deviceId: "device-123",
      runner
    });

    await expect(
      adapter.execute({
        runId: "run-001",
        store,
        step: step("step-push", "push", {
          src_ref: "/tmp/app",
          dst_path: "relative/path"
        })
      })
    ).rejects.toThrow("dst_path must be an absolute target path");
    expect(runner.invocations).toEqual([]);
  });

  it("registers configured real adapters without exposing an extra generic capability", () => {
    const registry = new RealAdapterRegistry({
      adb: { deviceId: "device-123", runner: new RecordingRunner([]) },
      flash: {
        method: "fastboot",
        partition: "boot",
        artifactType: "boot_img",
        runner: new RecordingRunner([])
      },
      serial: {
        port: "/dev/ttyUSB0",
        baudRate: 115200,
        reader: new FixedSerialReader("")
      }
    });

    expect(registry.get("shell_exec")).toBeInstanceOf(AdbAdapter);
    expect(registry.get("flash")).toBeInstanceOf(FlashAdapter);
    expect(registry.get("watch_serial")).toBeInstanceOf(SerialAdapter);
  });

  it("runs host tools through spawn argv and reports timeouts", async () => {
    const runner = new SpawnCommandRunner();

    const result = await runner.run({
      file: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutSec: 0.01
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationSec).toBeGreaterThanOrEqual(0);
  });

  it("reports stdout truncation from the spawn runner", async () => {
    const runner = new SpawnCommandRunner({ maxOutputBytes: 2 });

    const result = await runner.run({
      file: process.execPath,
      args: ["-e", "process.stdout.write('abcdef')"],
      timeoutSec: 1
    });

    expect(result.stdout).toBe("ab");
    expect(result.stdoutTruncated).toBe(true);
  });
});

function commandResult(result: Omit<CommandRunResult, "stdoutTruncated" | "stderrTruncated">): CommandRunResult {
  return {
    ...result,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function step(id: string, capability: PlanStep["capability"], input: Record<string, unknown>): PlanStep {
  return {
    id,
    capability,
    condition: "always",
    input,
    timeout_sec: 60
  };
}
