import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapterRegistry } from "@artifact-validation/adapters";
import type { Plan, ValidateArtifactInput } from "@artifact-validation/contracts";
import { buildRuntimeServer, type RuntimeServer } from "../src/index.js";

describe("runtime-server HTTP API", () => {
  let rootDir: string;
  let artifactPath: string;
  let server: RuntimeServer | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-runtime-server-"));
    artifactPath = path.join(rootDir, "firmware.img");
    await writeFile(artifactPath, "fake firmware\n");
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.app.close();
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it("creates a run, executes a configured hand-written plan, and exposes status/events/evidence", async () => {
    server = buildRuntimeServer({
      rootDir,
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
          dmesg: "clean dmesg\n"
        }
      }),
      planFactory: () => demoPlan(),
      executePlansInline: true,
      idFactory: () => "run-001",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "accepted",
      run_id: "run-001",
      target: "board-01",
      state: "completed"
    });

    const status = await server.app.inject({ method: "GET", url: "/api/runs/run-001/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      run_id: "run-001",
      status: "completed",
      last_event_seq: 19
    });

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-001/events?after_seq=0&limit=5" });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({
      run_id: "run-001",
      next_after_seq: 5,
      has_more: true
    });
    expect(events.json().events).toHaveLength(5);

    const evidence = await server.app.inject({ method: "GET", url: "/api/runs/run-001/evidence" });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().refs.map((ref: { ref: string }) => ref.ref)).toEqual([
      "flash:log",
      "serial:full",
      "adb:step-smoke",
      "log:dmesg"
    ]);

    const evidenceRef = await server.app.inject({
      method: "GET",
      url: "/api/runs/run-001/evidence?ref=serial%3Afull"
    });
    expect(evidenceRef.statusCode).toBe(200);
    expect(evidenceRef.json()).toMatchObject({
      ref: "serial:full",
      kind: "log"
    });

    const missingEvidenceRef = await server.app.inject({
      method: "GET",
      url: "/api/runs/run-001/evidence?ref=serial%3Amissing"
    });
    expect(missingEvidenceRef.statusCode).toBe(404);
    expect(missingEvidenceRef.json()).toEqual({
      status: "error",
      error_code: "resource_not_found",
      message: "evidence ref serial:missing was not found"
    });

    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-001/result" });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      run_id: "run-001",
      status: "completed",
      summary: "run completed; review event stream and evidence refs for details",
      key_evidence: []
    });
  });

  it("uses Task Planner output when no hand-written plan is supplied", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 0,
            stdout: "pass\n",
            stderr: ""
          }
        },
        logs: {
          dmesg: "clean dmesg\n"
        }
      }),
      taskPlanner: plannerThatReturns({ status: "planned", plan: demoPlan() }),
      executePlansInline: true,
      idFactory: () => "run-planner-001",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "accepted",
      run_id: "run-planner-001",
      state: "completed"
    });
  });

  it("writes Agent Reply after background plan execution finishes", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 0,
            stdout: "pass\n",
            stderr: ""
          }
        },
        logs: {
          dmesg: "clean dmesg\n"
        }
      }),
      planFactory: () => demoPlan(),
      executePlansInline: false,
      idFactory: () => "run-background",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(created.json()).toMatchObject({
      status: "accepted",
      run_id: "run-background"
    });

    const result = await waitForResult(server, "run-background");
    expect(result).toMatchObject({
      run_id: "run-background",
      status: "completed",
      summary: "run completed; review event stream and evidence refs for details"
    });
  });

  it("writes Agent Reply after background plan execution is rejected", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      planFactory: () => duplicateStepPlan(),
      executePlansInline: false,
      idFactory: () => "run-background-bad-plan",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(created.json()).toMatchObject({
      status: "accepted",
      run_id: "run-background-bad-plan"
    });

    const result = await waitForResult(server, "run-background-bad-plan");
    expect(result).toMatchObject({
      run_id: "run-background-bad-plan",
      status: "failed",
      summary: "run failed; review event stream and evidence refs for details"
    });
  });

  it("returns clarification_needed and fails the run when Task Planner needs missing input", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      taskPlanner: plannerThatReturns({
        status: "clarification_needed",
        reasons: ["planner cannot invent shell_exec command without test_hint"],
        missing_info: ["Task Planner output needs more input"],
        suggested_next: "Provide a test_hint and retry."
      }),
      executePlansInline: true,
      idFactory: () => "run-planner-reject",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: inputWithoutTestHint(artifactPath)
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "clarification_needed",
      run_id: "run-planner-reject",
      missing_info: ["Task Planner output needs more input"]
    });

    const status = await server.app.inject({ method: "GET", url: "/api/runs/run-planner-reject/status" });
    expect(status.json()).toMatchObject({
      run_id: "run-planner-reject",
      status: "failed"
    });
  });

  it("fails the run when executor rejects a Task Planner plan", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      taskPlanner: plannerThatReturns({ status: "planned", plan: duplicateStepPlan() }),
      executePlansInline: true,
      idFactory: () => "run-bad-plan",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    expect(created.json()).toMatchObject({
      status: "plan_rejected",
      run_id: "run-bad-plan"
    });

    const status = await server.app.inject({ method: "GET", url: "/api/runs/run-bad-plan/status" });
    expect(status.json()).toMatchObject({
      run_id: "run-bad-plan",
      status: "failed"
    });
  });

  it("returns public errors for invalid input and missing runs", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry()
    });

    const invalid = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: {
        context: {
          task: "missing fields"
        }
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      status: "error",
      error_code: "invalid_request"
    });

    const missing = await server.app.inject({ method: "GET", url: "/api/runs/run-missing/status" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      status: "error",
      error_code: "run_not_found",
      message: "run run-missing was not found"
    });
  });

  it("supports cancel and limited interventions without exposing device_exec", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      idFactory: () => "run-001",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(created.json()).toMatchObject({
      status: "accepted",
      state: "planning"
    });

    const pendingResult = await server.app.inject({ method: "GET", url: "/api/runs/run-001/result" });
    expect(pendingResult.json()).toEqual({
      run_id: "run-001",
      status: "planning",
      result_available: false
    });

    const intervention = await server.app.inject({
      method: "POST",
      url: "/api/runs/run-001/interventions",
      payload: {
        action: "request_partial_evidence",
        reason: "show current evidence"
      }
    });
    expect(intervention.statusCode).toBe(200);
    expect(intervention.json()).toMatchObject({
      run_id: "run-001",
      accepted: true,
      action: "request_partial_evidence",
      status: "planning"
    });

    const cancel = await server.app.inject({
      method: "POST",
      url: "/api/runs/run-001/cancel",
      payload: {
        reason: "test cancel"
      }
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({
      run_id: "run-001",
      status: "cancelled"
    });

    const cancelledResult = await server.app.inject({ method: "GET", url: "/api/runs/run-001/result" });
    expect(cancelledResult.statusCode).toBe(200);
    expect(cancelledResult.json()).toMatchObject({
      run_id: "run-001",
      status: "cancelled",
      summary: "run cancelled; review event stream and evidence refs for details"
    });

    const capabilities = await server.app.inject({ method: "GET", url: "/api/targets/board-01/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().capabilities.map((capability: { name: string }) => capability.name)).toEqual([
      "flash",
      "push",
      "watch_serial",
      "wait_adb",
      "shell_exec",
      "check_process",
      "collect_logs",
      "save_snapshot"
    ]);

    const notFound = await server.app.inject({ method: "POST", url: "/api/device_exec", payload: { command: "id" } });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      status: "error",
      error_code: "resource_not_found",
      message: "route not found"
    });
  });
});

function validInput(artifact: string): ValidateArtifactInput {
  return {
    context: {
      task: "验证 boot crash 是否修复",
      what_changed: "调整 init service 启动顺序",
      expected: "设备能启动完成，ADB 能回来",
      concerns: ["kernel panic", "init timeout", "adb offline"],
      test_hint: {
        kind: "adb_shell",
        command: "/vendor/bin/smoke_test",
        timeout_sec: 60,
        expected_exit_code: 0
      }
    },
    artifact: {
      path: artifact,
      type: "firmware_img"
    },
    target: "board-01",
    constraints: {
      max_duration_sec: 600,
      allow_flash: true,
      allow_reboot: true,
      allow_power_cycle: false
    }
  };
}

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
          items: ["dmesg"]
        },
        timeout_sec: 60
      }
    ],
    success_criteria: ["smoke test exits 0", "no panic pattern"],
    failure_signals: ["kernel panic", "adb offline", "smoke test failure"],
    evidence_policy: {
      always: ["flash:log", "serial:full"],
      on_success: ["dmesg"],
      on_failure: ["dmesg", "serial:full"]
    }
  };
}

function duplicateStepPlan(): Plan {
  const plan = demoPlan();
  return {
    ...plan,
    plan_id: "plan-duplicate-step",
    steps: [
      {
        id: "step-duplicate",
        capability: "watch_serial",
        condition: "always",
        input: {
          duration_sec: 10
        },
        timeout_sec: 10
      },
      {
        id: "step-duplicate",
        capability: "wait_adb",
        condition: "always",
        input: {
          timeout_sec: 10
        },
        timeout_sec: 10
      }
    ]
  };
}

function inputWithoutTestHint(artifact: string): ValidateArtifactInput {
  const input = validInput(artifact);
  return {
    ...input,
    context: {
      task: "验证 boot crash 是否修复",
      what_changed: "调整 init service 启动顺序",
      expected: "设备能启动完成，ADB 能回来",
      concerns: ["kernel panic", "init timeout", "adb offline"]
    }
  };
}

function plannerThatReturns(result: Awaited<ReturnType<NonNullable<Parameters<typeof buildRuntimeServer>[0]["taskPlanner"]>["plan"]>>) {
  return {
    plan: async () => result
  };
}

async function waitForResult(runtimeServer: RuntimeServer, runId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response = await runtimeServer.app.inject({ method: "GET", url: `/api/runs/${runId}/result` });
    const body = response.json();
    if (body.result_available !== false) {
      return body;
    }
  }
  throw new Error(`result for ${runId} was not available`);
}
