import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapterRegistry } from "@artifact-validation/adapters";
import type { CapabilityAdapter, CapabilityAdapterRegistry, CapabilityExecutionContext } from "@artifact-validation/adapters";
import type { CapabilityName, Plan } from "@artifact-validation/contracts";
import { FileStore } from "@artifact-validation/file-store";
import { PlanExecutor, RunManager, validatePlanForExecution } from "../src/index.js";

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

  it("rejects a plan using capabilities outside the target/request allowance", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const executor = new PlanExecutor({ store, runManager, adapters: new FakeAdapterRegistry() });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: demoPlan(),
      allowedCapabilities: ["watch_serial", "wait_adb", "collect_logs", "save_snapshot"]
    });

    expect(result).toEqual({
      accepted: false,
      error_code: "plan_rejected",
      message:
        "plan plan-demo cannot execute: capability flash is not available for this target/request; capability shell_exec is not available for this target/request"
    });
    expect((await store.readRun("run-001")).status).toBe("failed");
  });

  it("rejects invalid capability input before executing adapters", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    let adapterCalls = 0;
    const shellAdapter: CapabilityAdapter = {
      capability: "shell_exec",
      async execute(_context: CapabilityExecutionContext) {
        adapterCalls += 1;
        return {
          capability: "shell_exec",
          success: true,
          status: "completed",
          output: {},
          evidence_refs: [],
          summary: "should not execute"
        };
      }
    };
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: {
        get(capability) {
          return capability === "shell_exec" ? shellAdapter : undefined;
        }
      }
    });

    const result = await executor.executePlan({
      runId: "run-001",
      plan: oneStepPlan({
        id: "step-invalid-shell",
        capability: "shell_exec",
        condition: "always",
        input: {
          expected_exit_code: 0
        },
        timeout_sec: 60
      })
    });

    expect(result).toEqual({
      accepted: false,
      error_code: "plan_rejected",
      message: "plan plan-one-step cannot execute: step step-invalid-shell shell_exec input.command must be a non-empty string"
    });
    expect(adapterCalls).toBe(0);
    expect((await store.readRun("run-001")).status).toBe("failed");
  });

  it("reports invalid capability input and timeout limit issues during plan validation", () => {
    const validation = validatePlanForExecution(
      {
        ...demoPlan(),
        steps: [
          {
            id: "step-push",
            capability: "push",
            condition: "always",
            input: {
              src_ref: "artifact-001",
              dst_path: "relative/path"
            },
            timeout_sec: 60
          },
          {
            id: "step-serial",
            capability: "watch_serial",
            condition: "always",
            input: {
              duration_sec: 601,
              patterns: ["panic"]
            },
            timeout_sec: 601
          }
        ]
      },
      new FakeAdapterRegistry()
    );

    expect(validation).toEqual({
      accepted: false,
      issues: [
        "step step-push push input.dst_path must be an absolute path",
        "step step-serial watch_serial timeout_sec must be <= 600",
        "step step-serial watch_serial input.duration_sec must be <= 600"
      ]
    });
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

  it("pauses after the current step and resumes without re-running completed steps", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const calls: string[] = [];
    let firstStepFinished!: () => void;
    const firstStepFinishedPromise = new Promise<void>(resolve => {
      firstStepFinished = resolve;
    });
    const adapter: CapabilityAdapter = {
      capability: "shell_exec",
      async execute(context: CapabilityExecutionContext) {
        calls.push(context.step.id);
        if (context.step.id === "step-one") {
          await runManager.transitionRun({ runId: "run-001", to: "paused", reason: "human pause", source: "caller" });
          firstStepFinished();
        }
        return {
          capability: "shell_exec",
          success: true,
          status: "completed",
          output: {},
          evidence_refs: [],
          summary: `${context.step.id} completed`
        };
      }
    };
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: {
        get(capability) {
          return capability === "shell_exec" ? adapter : undefined;
        }
      },
      controlPollMs: 1
    });

    const execution = executor.executePlan({
      runId: "run-001",
      plan: twoStepShellPlan()
    });
    await firstStepFinishedPromise;
    await sleep(10);

    expect(calls).toEqual(["step-one"]);
    expect((await store.readRun("run-001")).status).toBe("paused");

    await runManager.transitionRun({ runId: "run-001", to: "running", reason: "human resume", source: "caller" });
    const result = await execution;

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(calls).toEqual(["step-one", "step-two"]);
    expect(result.step_results.map(step => step.step_id)).toEqual(["step-one", "step-two"]);
    expect(result.run.status).toBe("completed");
  });

  it("stops before the next step when a paused run is cancelled", async () => {
    await runManager.createRun({ runId: "run-001", initialState: "planning" });
    const calls: string[] = [];
    let firstStepFinished!: () => void;
    const firstStepFinishedPromise = new Promise<void>(resolve => {
      firstStepFinished = resolve;
    });
    const adapter: CapabilityAdapter = {
      capability: "shell_exec",
      async execute(context: CapabilityExecutionContext) {
        calls.push(context.step.id);
        if (context.step.id === "step-one") {
          await runManager.transitionRun({ runId: "run-001", to: "paused", reason: "human pause", source: "caller" });
          firstStepFinished();
        }
        return {
          capability: "shell_exec",
          success: true,
          status: "completed",
          output: {},
          evidence_refs: [],
          summary: `${context.step.id} completed`
        };
      }
    };
    const executor = new PlanExecutor({
      store,
      runManager,
      adapters: {
        get(capability) {
          return capability === "shell_exec" ? adapter : undefined;
        }
      },
      controlPollMs: 1
    });

    const execution = executor.executePlan({
      runId: "run-001",
      plan: twoStepShellPlan()
    });
    await firstStepFinishedPromise;
    await runManager.transitionRun({ runId: "run-001", to: "cancelled", reason: "human cancel", source: "caller" });
    const result = await execution;

    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      return;
    }
    expect(calls).toEqual(["step-one"]);
    expect(result.run.status).toBe("cancelled");
    expect(result.step_results.map(step => step.step_id)).toEqual(["step-one"]);
    expect((await store.readEvents("run-001")).map(event => event.type)).toContain("run_cancelled");
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
          artifact_ref: "artifact-001",
          artifact_type: "firmware_img"
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

function twoStepShellPlan(): Plan {
  return {
    plan_id: "plan-two-shell-steps",
    estimated_duration_sec: 120,
    steps: [
      {
        id: "step-one",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/one",
          expected_exit_code: 0
        },
        timeout_sec: 60
      },
      {
        id: "step-two",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/two",
          expected_exit_code: 0
        },
        timeout_sec: 60
      }
    ],
    success_criteria: ["both steps complete"],
    failure_signals: ["step fails"],
    evidence_policy: {
      always: []
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
