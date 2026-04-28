import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapterRegistry } from "@artifact-validation/adapters";
import type { CapabilityAdapter, CapabilityAdapterRegistry, CapabilityExecutionContext } from "@artifact-validation/adapters";
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

  it("continues later main-path steps after a non-fatal continue policy failure", async () => {
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
        processes: {
          demo: {
            pid: 42,
            state: "running"
          }
        },
        logs: {
          dmesg: "should not be collected on success\n"
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
            on_failure: "continue"
          },
          {
            id: "step-nonfatal-diagnostics",
            capability: "collect_logs",
            condition: "on_failure",
            input: {
              items: ["dmesg"]
            },
            timeout_sec: 60
          },
          {
            id: "step-after-continue",
            capability: "check_process",
            condition: "always",
            input: {
              process_name: "demo"
            },
            timeout_sec: 30
          },
          {
            id: "step-success-only",
            capability: "collect_logs",
            condition: "on_success",
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
    expect(result.run.status).toBe("completed");
    expect(result.step_results.map(step => step.step_id)).toEqual([
      "step-flash",
      "step-serial",
      "step-adb",
      "step-smoke",
      "step-nonfatal-diagnostics",
      "step-after-continue"
    ]);
    expect(result.step_results.find(step => step.step_id === "step-smoke")?.status).toBe("failed");
    expect((await store.readEvidenceIndex("run-001")).refs.map(ref => ref.ref)).toContain("log:dmesg");
  });

  it("emits step_timeout when an adapter exceeds the executor timeout", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const hangingShellAdapter: CapabilityAdapter = {
      capability: "shell_exec",
      execute(_context: CapabilityExecutionContext) {
        return new Promise(() => undefined);
      }
    };
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: {
        get(capability) {
          return capability === "shell_exec" ? hangingShellAdapter : undefined;
        }
      },
      timeoutMsForStep: () => 1
    });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: oneStepPlan({
        id: "step-hangs",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/hangs",
          expected_exit_code: 0
        },
        timeout_sec: 1
      })
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("failed");
    expect(result.step_results).toMatchObject([
      {
        step_id: "step-hangs",
        status: "timeout",
        success: false
      }
    ]);
    expect((await store.readEvents("run-001")).map(event => event.type)).toContain("step_timeout");
  });

  it("converts adapter exceptions into step_failed events", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const throwingAdapter: CapabilityAdapter = {
      capability: "shell_exec",
      async execute(_context: CapabilityExecutionContext) {
        throw new Error("adapter exploded");
      }
    };
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: {
        get(capability) {
          return capability === "shell_exec" ? throwingAdapter : undefined;
        }
      }
    });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: oneStepPlan({
        id: "step-throws",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/throws",
          expected_exit_code: 0
        },
        timeout_sec: 60
      })
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(result.run.status).toBe("failed");
    expect(result.step_results).toMatchObject([
      {
        step_id: "step-throws",
        status: "failed",
        summary: "adapter exploded"
      }
    ]);
    expect((await store.readEvents("run-001")).map(event => event.type)).toContain("step_failed");
  });

  it("rejects duplicate step ids before executing adapters", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: new FakeAdapterRegistry()
    });
    const plan = demoPlan();

    const result = await executor.executePlan({
      runId: "run-001",
      plan: {
        ...plan,
        steps: [
          plan.steps[0]!,
          {
            ...plan.steps[1]!,
            id: plan.steps[0]!.id
          }
        ]
      }
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) {
      return;
    }
    expect(result.error_code).toBe("plan_rejected");
    expect(result.message).toContain("duplicate step id step-flash");
    expect((await store.readRun("run-001")).status).toBe("failed");
    expect((await store.readEvents("run-001")).map(event => event.type)).not.toContain("step_started");
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

function oneStepPlan(step: Plan["steps"][number]): Plan {
  return {
    plan_id: "plan-one-step",
    estimated_duration_sec: step.timeout_sec,
    steps: [step],
    success_criteria: ["step succeeds"],
    failure_signals: ["step fails"],
    evidence_policy: {
      always: []
    }
  };
}
