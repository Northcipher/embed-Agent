import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapterRegistry } from "@artifact-validation/adapters";
import type { CapabilityAdapterRegistry } from "@artifact-validation/adapters";
import type { CapabilityName, Plan } from "@artifact-validation/contracts";
import { FileStore } from "@artifact-validation/file-store";
import { PlanExecutor, RunManager } from "../src/index.js";

describe("PlanExecutor", () => {
  let rootDir: string;
  let store: FileStore;
  let runManager: RunManager;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-plan-executor-"));
    const now = () => new Date("2026-04-28T02:00:00.000Z");
    store = new FileStore({ rootDir, now });
    runManager = new RunManager({ store, now });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("executes a hand-written plan through fake adapters and completes the run", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "init started", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 0,
            stdout: "pass\n",
            stderr: ""
          }
        },
        logs: {
          dmesg: "clean dmesg\n",
          logcat: "clean logcat\n"
        }
      }),
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: demoPlan()
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("completed");
    expect(result.step_results.map(step => [step.step_id, step.status])).toEqual([
      ["step-flash", "completed"],
      ["step-serial", "completed"],
      ["step-adb", "completed"],
      ["step-smoke", "completed"],
      ["step-logs", "completed"]
    ]);
    expect((await store.readRun("run-001")).status).toBe("completed");
    expect((await store.readEvents("run-001")).map(event => event.type)).toEqual([
      "run_created",
      "state_changed",
      "step_started",
      "step_completed",
      "evidence_collected",
      "step_started",
      "step_completed",
      "evidence_collected",
      "step_started",
      "step_completed",
      "step_started",
      "step_completed",
      "evidence_collected",
      "step_started",
      "step_completed",
      "evidence_collected",
      "state_changed",
      "state_changed",
      "run_completed"
    ]);
    expect((await store.readEvidenceIndex("run-001")).refs.map(ref => ref.ref)).toEqual([
      "flash:log",
      "serial:full",
      "adb:step-smoke",
      "log:dmesg",
      "log:logcat"
    ]);
  });

  it("rejects a plan with missing adapter coverage and fails a planning run", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const registry: CapabilityAdapterRegistry = {
      get(capability: CapabilityName) {
        return capability === "wait_adb" ? undefined : new FakeAdapterRegistry().get(capability);
      }
    };
    const executor = new PlanExecutor({ store, runManager, adapters: registry });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: demoPlan()
    });

    expect(result).toEqual({
      accepted: false,
      error_code: "plan_rejected",
      message: "plan plan-demo cannot execute: missing adapter for wait_adb"
    });
    expect((await store.readRun("run-001")).status).toBe("failed");
    expect((await store.readEvents("run-001")).map(event => event.type)).toEqual(["run_created", "state_changed", "run_failed"]);
  });

  it("runs on_failure collection steps and fails the run after a fatal step failure", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: new FakeAdapterRegistry({
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 2,
            stdout: "bad\n",
            stderr: "failed\n"
          }
        },
        logs: {
          dmesg: "panic trace\n"
        }
      })
    });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: {
        ...demoPlan(),
        steps: [
          ...demoPlan().steps.slice(0, 4),
          {
            id: "step-success-only",
            capability: "check_process",
            condition: "on_success",
            input: {
              process_name: "demo"
            },
            timeout_sec: 30
          },
          {
            id: "step-danger-after-failure",
            capability: "shell_exec",
            condition: "always",
            input: {
              command: "/vendor/bin/should_not_run",
              expected_exit_code: 0
            },
            timeout_sec: 60
          },
          {
            id: "step-logs",
            capability: "collect_logs",
            condition: "on_failure",
            input: {
              items: ["dmesg"]
            },
            timeout_sec: 60
          }
        ]
      }
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("failed");
    expect(result.step_results.map(step => step.step_id)).toEqual(["step-flash", "step-serial", "step-adb", "step-smoke", "step-logs"]);
    expect(result.step_results.find(step => step.step_id === "step-smoke")?.status).toBe("failed");
    expect((await store.readEvidenceIndex("run-001")).refs.map(ref => ref.ref)).toContain("log:dmesg");
    expect((await store.readEvents("run-001")).map(event => event.type)).toContain("step_failed");
  });

  it("does not run on_failure collection steps when a failed step policy is fail", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: new FakeAdapterRegistry({
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 2,
            stdout: "bad\n",
            stderr: "failed\n"
          }
        },
        logs: {
          dmesg: "should not be collected\n"
        }
      })
    });

    const plan = demoPlan();
    const result = await executor.executePlan({
      runId: "run-001",
      plan: {
        ...plan,
        steps: [
          ...plan.steps.slice(0, 3),
          {
            ...plan.steps[3]!,
            on_failure: "fail"
          },
          {
            id: "step-logs",
            capability: "collect_logs",
            condition: "on_failure",
            input: {
              items: ["dmesg"]
            },
            timeout_sec: 60
          }
        ]
      }
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("failed");
    expect(result.step_results.map(step => step.step_id)).toEqual(["step-flash", "step-serial", "step-adb", "step-smoke"]);
    expect((await store.readEvidenceIndex("run-001")).refs.map(ref => ref.ref)).not.toContain("log:dmesg");
  });

  it("rejects paused runs instead of restarting the plan without a step cursor", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    await runManager.transitionRun({ runId: "run-001", to: "running", reason: "plan accepted" });
    await runManager.transitionRun({ runId: "run-001", to: "paused", reason: "human pause" });
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: new FakeAdapterRegistry()
    });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: demoPlan()
    });

    expect(result).toEqual({
      accepted: false,
      error_code: "invalid_request",
      message: "cannot execute plan while run run-001 is paused"
    });
    expect((await store.readRun("run-001")).status).toBe("paused");
    expect((await store.readEvents("run-001")).map(event => event.type)).not.toContain("step_started");
  });
});

function demoPlan(): Plan {
  return {
    plan_id: "plan-demo",
    estimated_duration_sec: 600,
    steps: [
      {
        id: "step-flash",
        capability: "flash",
        condition: "always",
        input: {
          artifact_ref: "artifact-001"
        },
        timeout_sec: 300
      },
      {
        id: "step-serial",
        capability: "watch_serial",
        condition: "always",
        input: {
          duration_sec: 180,
          patterns: ["kernel panic", "boot completed"]
        },
        timeout_sec: 180
      },
      {
        id: "step-adb",
        capability: "wait_adb",
        condition: "always",
        input: {
          timeout_sec: 180
        },
        timeout_sec: 180
      },
      {
        id: "step-smoke",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/smoke_test",
          expected_exit_code: 0
        },
        timeout_sec: 60
      },
      {
        id: "step-logs",
        capability: "collect_logs",
        condition: "on_success",
        input: {
          items: ["dmesg", "logcat"]
        },
        timeout_sec: 60
      }
    ],
    success_criteria: ["smoke test exits 0", "no panic pattern"],
    failure_signals: ["kernel panic", "adb offline", "smoke test failure"],
    evidence_policy: {
      always: ["flash:log", "serial:full"],
      on_success: ["dmesg", "logcat"],
      on_failure: ["dmesg", "logcat", "serial:full"]
    }
  };
}
