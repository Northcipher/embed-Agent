import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapterRegistry } from "@artifact-validation/adapters";
import type { EventSeverity, EventSource, EventType, Plan, RunEvent, TargetProfile, ValidateArtifactInput } from "@artifact-validation/contracts";
import { FileStore } from "@artifact-validation/file-store";
import {
  buildRuntimeServer,
  buildRuntimeServerWithLlmConfig,
  shouldTriggerObserver,
  type RuntimeObserverInput,
  type RuntimeReplyGeneratorInput,
  type RuntimeServer
} from "../src/index.js";

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

  it("derives phase and current_step from the active step events in run status", async () => {
    const now = () => new Date("2026-04-28T02:00:30.000Z");
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      now
    });
    const store = new FileStore({ rootDir, now });
    await store.createRun({
      run_id: "run-active-step",
      status: "running",
      request: validInput(artifactPath)
    });
    await store.appendEvent("run-active-step", {
      time: "2026-04-28T02:00:10.000Z",
      elapsed_sec: 10,
      type: "step_started",
      severity: "info",
      source: "orchestrator",
      step_id: "step-watch-serial",
      summary: "watch serial started",
      payload: {
        capability: "watch_serial",
        timeout_sec: 180
      }
    });

    const active = await server.app.inject({ method: "GET", url: "/api/runs/run-active-step/status" });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      run_id: "run-active-step",
      status: "running",
      phase: "watch_serial",
      current_step: {
        id: "step-watch-serial",
        capability: "watch_serial",
        started_at: "2026-04-28T02:00:10.000Z",
        timeout_sec: 180
      }
    });

    await store.appendEvent("run-active-step", {
      time: "2026-04-28T02:00:11.000Z",
      elapsed_sec: 11,
      type: "step_started",
      severity: "warning",
      source: "orchestrator",
      summary: "malformed step event should be ignored",
      payload: {
        capability: "unknown_capability",
        timeout_sec: 180
      }
    });
    const afterMalformedStarted = await server.app.inject({ method: "GET", url: "/api/runs/run-active-step/status" });
    expect(afterMalformedStarted.json()).toMatchObject({
      phase: "watch_serial",
      current_step: {
        id: "step-watch-serial",
        capability: "watch_serial"
      }
    });

    for (const type of ["step_completed", "step_failed", "step_timeout"] as const) {
      await store.appendEvent("run-active-step", {
        time: "2026-04-28T02:00:20.000Z",
        elapsed_sec: 20,
        type,
        severity: type === "step_completed" ? "info" : "warning",
        source: "tool_adapter",
        step_id: "step-watch-serial",
        summary: `${type} clears active step`,
        payload: {
          capability: "watch_serial"
        }
      });
      const cleared = await server.app.inject({ method: "GET", url: "/api/runs/run-active-step/status" });
      expect(cleared.json()).not.toHaveProperty("phase");
      expect(cleared.json()).not.toHaveProperty("current_step");

      await store.appendEvent("run-active-step", {
        time: "2026-04-28T02:00:21.000Z",
        elapsed_sec: 21,
        type: "step_started",
        severity: "info",
        source: "orchestrator",
        step_id: "step-watch-serial",
        summary: "watch serial restarted",
        payload: {
          capability: "watch_serial",
          timeout_sec: 180
        }
      });
    }

    const run = await store.readRun("run-active-step");
    await store.writeRun({ ...run, status: "completed" });
    const terminal = await server.app.inject({ method: "GET", url: "/api/runs/run-active-step/status" });
    expect(terminal.json()).not.toHaveProperty("phase");
    expect(terminal.json()).not.toHaveProperty("current_step");
  });

  it("derives target runtime state from current step capability in get_run_status", async () => {
    const now = () => new Date("2026-04-28T02:00:30.000Z");
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      now
    });
    const store = new FileStore({ rootDir, now });
    await store.createRun({
      run_id: "run-target-state-step",
      status: "running",
      request: validInput(artifactPath)
    });

    const cases: Array<{ capability: string; expectedState: string }> = [
      { capability: "flash", expectedState: "flashing" },
      { capability: "watch_serial", expectedState: "booting" },
      { capability: "wait_adb", expectedState: "booting" },
      { capability: "push", expectedState: "adb_ready" },
      { capability: "shell_exec", expectedState: "adb_ready" },
      { capability: "check_process", expectedState: "adb_ready" },
      { capability: "collect_logs", expectedState: "busy" },
      { capability: "save_snapshot", expectedState: "busy" }
    ];

    for (const item of cases) {
      await store.appendEvent("run-target-state-step", {
        time: "2026-04-28T02:00:10.000Z",
        elapsed_sec: 10,
        type: "step_started",
        severity: "info",
        source: "orchestrator",
        step_id: `step-${item.capability}`,
        summary: `${item.capability} started`,
        payload: {
          capability: item.capability,
          timeout_sec: 60
        }
      });
      const status = await server.app.inject({ method: "GET", url: "/api/runs/run-target-state-step/status" });
      expect(status.json()).toMatchObject({
        target: {
          state: item.expectedState
        }
      });
    }
  });

  it("filters run events by event types from HTTP query", async () => {
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
        }
      }),
      planFactory: () => demoPlan(),
      executePlansInline: true,
      idFactory: () => "run-event-filter",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const events = await server.app.inject({
      method: "GET",
      url: "/api/runs/run-event-filter/events?after_seq=0&limit=100&types=step_started,evidence_collected"
    });
    expect(events.statusCode).toBe(200);
    expect(new Set(events.json().events.map((event: { type: string }) => event.type))).toEqual(
      new Set(["step_started", "evidence_collected"])
    );

    const invalid = await server.app.inject({
      method: "GET",
      url: "/api/runs/run-event-filter/events?types=not_an_event"
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      status: "error",
      error_code: "invalid_request"
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

  it("uses mock LLM config to plan and generate the final reply", async () => {
    const configPath = path.join(rootDir, "llm.yaml");
    await writeFile(
      configPath,
      [
        "enabled: true",
        "default_provider: mock",
        "providers:",
        "  mock:",
        "    type: mock",
        "    model: mock-model",
        "    outputs:",
        `      - '${yamlSingleQuotedJson(taskPlannerOutput(demoPlan()))}'`,
        `      - '${yamlSingleQuotedJson({
          run_id: "run-llm-config",
          status: "completed",
          summary: "configured LLM reply",
          confidence: 0.8,
          key_evidence: [],
          suggested_next: "review configured reply and evidence refs",
          evidence_path: path.join(rootDir, "runs", "run-llm-config")
        })}'`,
        ""
      ].join("\n")
    );
    server = await buildRuntimeServerWithLlmConfig({
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
      llmConfigPath: configPath,
      executePlansInline: true,
      idFactory: () => "run-llm-config",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(created.json()).toMatchObject({
      status: "accepted",
      run_id: "run-llm-config",
      state: "completed"
    });

    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-llm-config/result" });
    expect(result.json()).toMatchObject({
      run_id: "run-llm-config",
      status: "completed",
      summary: "configured LLM reply"
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

  it("uses configured Reply Generator for terminal run result context", async () => {
    let capturedInput: RuntimeReplyGeneratorInput | undefined;
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
      replyGenerator: {
        generate: async input => {
          capturedInput = input;
          return {
            status: "generated",
            reply: {
              run_id: input.runId,
              status: input.finalStatus,
              summary: "generated validation summary",
              confidence: 0.8,
              key_evidence: [],
              suggested_next: "review the generated summary and evidence refs",
              evidence_path: input.evidencePath
            },
            brain_call: "reply-generator-001"
          };
        }
      },
      executePlansInline: true,
      idFactory: () => "run-generated-reply",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-generated-reply/result" });
    expect(result.json()).toMatchObject({
      run_id: "run-generated-reply",
      status: "completed",
      summary: "generated validation summary"
    });
    expect(capturedInput).toMatchObject({
      runId: "run-generated-reply",
      finalStatus: "completed",
      requestSummary: {
        task: "验证 boot crash 是否修复",
        expected: "设备能启动完成，ADB 能回来"
      },
      run: {
        run_id: "run-generated-reply",
        state: "completed"
      }
    });
    expect(capturedInput?.eventSummary.length).toBeGreaterThan(0);
    expect(capturedInput?.evidenceRefs).toEqual(["flash:log", "serial:full", "adb:step-smoke", "log:dmesg"]);
  });

  it("falls back to rule-based Agent Reply when configured Reply Generator fails", async () => {
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
        }
      }),
      planFactory: () => demoPlan(),
      replyGenerator: {
        generate: async () => {
          throw new Error("reply generator unavailable");
        }
      },
      executePlansInline: true,
      idFactory: () => "run-reply-fallback",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-reply-fallback/result" });
    expect(result.json()).toMatchObject({
      run_id: "run-reply-fallback",
      status: "completed",
      summary: "run completed; review event stream and evidence refs for details"
    });
  });

  it("falls back to rule-based Agent Reply when configured Reply Generator returns invalid evidence refs", async () => {
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
        }
      }),
      planFactory: () => demoPlan(),
      replyGenerator: {
        generate: async input => ({
          status: "generated",
          reply: {
            run_id: input.runId,
            status: input.finalStatus,
            summary: "generated validation summary",
            confidence: 0.8,
            key_evidence: [
              {
                summary: "missing evidence",
                evidence_refs: ["missing:ref"]
              }
            ],
            suggested_next: "review the generated summary and evidence refs",
            evidence_path: input.evidencePath
          },
          brain_call: "reply-generator-invalid"
        })
      },
      executePlansInline: true,
      idFactory: () => "run-reply-invalid",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-reply-invalid/result" });
    expect(result.json()).toMatchObject({
      run_id: "run-reply-invalid",
      status: "completed",
      summary: "run completed; review event stream and evidence refs for details",
      key_evidence: []
    });
  });

  it("writes intermediate observation events from configured Observer", async () => {
    let capturedInput: RuntimeObserverInput | undefined;
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 1,
            stdout: "fail\n",
            stderr: "smoke failed\n"
          }
        }
      }),
      planFactory: () => demoPlan(),
      observer: {
        observe: async input => {
          capturedInput = input;
          return {
            status: "accepted",
            intent: {
              intent: "intermediate_observation",
              reason: "smoke test failed after boot completed",
              confidence: 0.7,
              requested_actions: [],
              report_to_caller: true
            },
            brain_call: "observer-001"
          };
        }
      },
      executePlansInline: true,
      idFactory: () => "run-observer-note",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-note/events?after_seq=0&limit=100" });
    const observerEvent = events.json().events.find((event: { type: string }) => event.type === "intermediate_observation");
    expect(observerEvent).toMatchObject({
      type: "intermediate_observation",
      source: "observer",
      payload: {
        accepted: true,
        brain_call: "observer-001"
      }
    });
    expect(capturedInput).toMatchObject({
      runId: "run-observer-note",
      triggerEvent: {
        type: "step_failed"
      },
      allowedFollowUpCapabilities: ["collect_logs", "save_snapshot"]
    });
    expect(capturedInput?.evidenceWindows).toEqual([
      expect.objectContaining({
        ref: "adb:step-smoke",
        kind: "command_output",
        text: expect.stringContaining("smoke failed")
      })
    ]);
  });

  it("writes observer_intent events without executing requested actions", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 1,
            stdout: "fail\n",
            stderr: "smoke failed\n"
          }
        },
        logs: {
          dmesg: "would only exist if collect_logs ran\n"
        }
      }),
      planFactory: () => demoPlan(),
      observer: {
        observe: async () => ({
          status: "accepted",
          intent: {
            intent: "collect_more",
            reason: "collect dmesg after smoke failure",
            confidence: 0.8,
            requested_actions: [
              {
                capability: "collect_logs",
                input: {
                  items: ["dmesg"]
                }
              }
            ],
            report_to_caller: false
          },
          brain_call: "observer-collect"
        })
      },
      executePlansInline: true,
      idFactory: () => "run-observer-intent",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-intent/events?after_seq=0&limit=100" });
    const observerEvent = events.json().events.find((event: { type: string }) => event.type === "observer_intent");
    expect(observerEvent).toMatchObject({
      type: "observer_intent",
      source: "observer",
      payload: {
        accepted: true,
        brain_call: "observer-collect",
        intent: {
          intent: "collect_more"
        }
      }
    });

    const evidence = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-intent/evidence" });
    expect(evidence.json().refs.map((ref: { ref: string }) => ref.ref)).not.toContain("log:dmesg");
  });

  it("records observer output for each bounded trigger event from one execution", async () => {
    const triggerTypes: string[] = [];
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        commandResults: {
          "/vendor/bin/nonfatal": {
            exit_code: 1,
            stdout: "",
            stderr: "nonfatal failed\n"
          },
          "/vendor/bin/fatal": {
            exit_code: 1,
            stdout: "",
            stderr: "fatal failed\n"
          }
        }
      }),
      planFactory: () => twoFailurePlan(),
      observer: {
        observe: async input => {
          triggerTypes.push(input.triggerEvent.type);
          return {
            status: "accepted",
            intent: {
              intent: "continue",
              reason: `handled ${input.triggerEvent.step_id}`,
              confidence: 0.6,
              requested_actions: [],
              report_to_caller: false
            },
            brain_call: `observer-${triggerTypes.length}`
          };
        }
      },
      executePlansInline: true,
      idFactory: () => "run-observer-multiple",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-multiple/events?after_seq=0&limit=100" });
    const observerEvents = events.json().events.filter((event: { type: string }) => event.type === "observer_intent");
    expect(triggerTypes).toEqual(["step_failed", "step_failed"]);
    expect(observerEvents).toHaveLength(2);
    const triggerSeqs = observerEvents.map((event: { payload: { trigger_event_seq: number } }) => event.payload.trigger_event_seq);
    expect(new Set(triggerSeqs).size).toBe(2);
  });

  it("debounces observer triggers for repeated rule_matched events with the same rule_id", async () => {
    const triggerEvents: Array<{ type: string; ruleId: string | undefined }> = [];
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "service timeout", "boot completed"]
      }),
      planFactory: () => duplicateRuleMatchedPlan(),
      observer: {
        observe: async input => {
          triggerEvents.push({
            type: input.triggerEvent.type,
            ruleId: typeof input.triggerEvent.payload?.rule_id === "string" ? input.triggerEvent.payload.rule_id : undefined
          });
          return {
            status: "accepted",
            intent: {
              intent: "continue",
              reason: "duplicate rule matched handled",
              confidence: 0.6,
              requested_actions: [],
              report_to_caller: false
            },
            brain_call: `observer-rule-${triggerEvents.length}`
          };
        }
      },
      executePlansInline: true,
      idFactory: () => "run-observer-rule-debounce",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    expect(triggerEvents).toEqual([
      {
        type: "rule_matched",
        ruleId: "serial.pattern.service_timeout"
      }
    ]);

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-rule-debounce/events?after_seq=0&limit=200" });
    const observerEvents = events.json().events.filter((event: { type: string }) => event.type === "observer_intent");
    expect(observerEvents).toHaveLength(1);
  });

  it("only treats rule_matched warning and error events as Observer triggers", () => {
    expect(shouldTriggerObserver(runEvent("rule_matched", "error"))).toBe(true);
    expect(shouldTriggerObserver(runEvent("rule_matched", "warning"))).toBe(true);
    expect(shouldTriggerObserver(runEvent("rule_matched", "info"))).toBe(false);
    expect(shouldTriggerObserver(runEvent("rule_matched", "debug"))).toBe(false);
  });

  it("records Observer exceptions as rejected observer_intent events", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 1,
            stdout: "fail\n",
            stderr: "smoke failed\n"
          }
        }
      }),
      planFactory: () => demoPlan(),
      observer: {
        observe: async () => {
          throw new Error("observer exploded");
        }
      },
      executePlansInline: true,
      idFactory: () => "run-observer-throws",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-throws/events?after_seq=0&limit=100" });
    const observerEvent = events.json().events.find((event: { type: string }) => event.type === "observer_intent");
    expect(observerEvent).toMatchObject({
      type: "observer_intent",
      severity: "warning",
      payload: {
        accepted: false,
        brain_call: "observer-unavailable",
        reasons: ["observer exploded"],
        intent: {
          intent: "continue"
        }
      }
    });
  });

  it("records rejected Observer output as observer_intent event", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry({
        serialOutput: ["Booting Linux", "boot completed"],
        commandResults: {
          "/vendor/bin/smoke_test": {
            exit_code: 1,
            stdout: "fail\n",
            stderr: "smoke failed\n"
          }
        }
      }),
      planFactory: () => demoPlan(),
      observer: {
        observe: async () => ({
          status: "rejected",
          reasons: ["unsupported requested action"],
          fallback_intent: {
            intent: "continue",
            reason: "fallback after invalid Observer output",
            confidence: 0,
            requested_actions: [],
            report_to_caller: false
          },
          brain_call: "observer-rejected"
        })
      },
      executePlansInline: true,
      idFactory: () => "run-observer-rejected",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    const events = await server.app.inject({ method: "GET", url: "/api/runs/run-observer-rejected/events?after_seq=0&limit=100" });
    const observerEvent = events.json().events.find((event: { type: string }) => event.type === "observer_intent");
    expect(observerEvent).toMatchObject({
      type: "observer_intent",
      severity: "warning",
      payload: {
        accepted: false,
        brain_call: "observer-rejected",
        reasons: ["unsupported requested action"]
      }
    });
  });

  it("does not call configured Reply Generator again when terminal reply already exists", async () => {
    let callCount = 0;
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      replyGenerator: {
        generate: async input => {
          callCount += 1;
          return {
            status: "generated",
            reply: {
              run_id: input.runId,
              status: input.finalStatus,
              summary: "generated cancelled summary",
              confidence: 0.8,
              key_evidence: [],
              suggested_next: "review cancellation reason and rerun when ready",
              evidence_path: input.evidencePath
            },
            brain_call: `reply-generator-${callCount}`
          };
        }
      },
      idFactory: () => "run-reply-once",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    await server.app.inject({
      method: "POST",
      url: "/api/runs/run-reply-once/cancel",
      payload: {
        reason: "first cancel"
      }
    });
    await server.app.inject({
      method: "POST",
      url: "/api/runs/run-reply-once/cancel",
      payload: {
        reason: "second cancel"
      }
    });

    expect(callCount).toBe(1);
    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-reply-once/result" });
    expect(result.json()).toMatchObject({
      run_id: "run-reply-once",
      status: "cancelled",
      summary: "generated cancelled summary"
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

  it("returns target_not_found when configured target profiles do not include the requested target", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      targetProfiles: [targetProfile()],
      executePlansInline: true,
      idFactory: () => "run-missing-target",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: {
        ...validInput(artifactPath),
        target: "missing-board"
      }
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({
      status: "target_not_found",
      target: "missing-board",
      reasons: ["target missing-board was not found"],
      missing_info: ["target profile"],
      suggested_next: "Configure a target profile before validating artifacts for this target."
    });

    const status = await server.app.inject({ method: "GET", url: "/api/runs/run-missing-target/status" });
    expect(status.statusCode).toBe(404);
  });

  it("locks a target while a run is non-terminal and releases it at terminal state", async () => {
    const runIds = ["run-lock-001", "run-lock-002"];
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      targetProfiles: [targetProfile()],
      idFactory: () => runIds.shift() ?? "run-extra",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const first = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(first.json()).toMatchObject({
      status: "accepted",
      run_id: "run-lock-001",
      state: "planning"
    });

    const busyCapabilities = await server.app.inject({ method: "GET", url: "/api/targets/board-01/capabilities" });
    expect(busyCapabilities.json().runtime_state).toMatchObject({
      target_id: "board-01",
      state: "busy",
      current_run_id: "run-lock-001"
    });

    const status = await server.app.inject({ method: "GET", url: "/api/runs/run-lock-001/status" });
    expect(status.json().target).toMatchObject({
      target_id: "board-01",
      state: "busy",
      current_run_id: "run-lock-001"
    });

    const second = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(second.json()).toEqual({
      status: "busy",
      target: "board-01",
      reasons: ["target board-01 is busy with run run-lock-001"],
      missing_info: [],
      suggested_next: "Wait for the current run to finish or cancel it before starting another validation."
    });
    const notCreated = await server.app.inject({ method: "GET", url: "/api/runs/run-lock-002/status" });
    expect(notCreated.statusCode).toBe(404);

    await server.app.inject({
      method: "POST",
      url: "/api/runs/run-lock-001/cancel",
      payload: {
        reason: "release target"
      }
    });

    const idleCapabilities = await server.app.inject({ method: "GET", url: "/api/targets/board-01/capabilities" });
    expect(idleCapabilities.json().runtime_state).toMatchObject({
      target_id: "board-01",
      state: "idle",
      current_run_id: null
    });

    const afterRelease = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });
    expect(afterRelease.json()).toMatchObject({
      status: "accepted",
      run_id: "run-lock-002"
    });
  });

  it("infers target capabilities from profile connections and safety flags", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      targetProfiles: [
        targetProfile({
          connections: {
            serial: {
              port: "/dev/ttyUSB0",
              baud: 115200
            }
          },
          flash: undefined,
          safety: {
            allow_flash: false,
            allow_shell_exec: false
          }
        })
      ]
    });

    const capabilities = await server.app.inject({ method: "GET", url: "/api/targets/board-01/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilityAvailability(capabilities.json().capabilities)).toMatchObject({
      flash: false,
      watch_serial: true,
      wait_adb: false,
      shell_exec: false,
      check_process: false,
      collect_logs: true,
      save_snapshot: true
    });

    const missing = await server.app.inject({ method: "GET", url: "/api/targets/missing-board/capabilities" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      status: "error",
      error_code: "target_not_found"
    });
  });

  it("rejects plan steps using capabilities disabled by request constraints", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      targetProfiles: [targetProfile()],
      planFactory: () => demoPlan(),
      executePlansInline: true,
      idFactory: () => "run-capability-disabled",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: {
        ...validInput(artifactPath),
        constraints: {
          ...validInput(artifactPath).constraints,
          allow_shell_exec: false
        }
      }
    });

    expect(created.json()).toMatchObject({
      status: "plan_rejected",
      run_id: "run-capability-disabled"
    });
    expect(created.json().reasons[0]).toContain("capability shell_exec is not available for this target/request");
  });

  it("applies request capability constraints even when target profiles are not configured", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      planFactory: () => demoPlan(),
      executePlansInline: true,
      idFactory: () => "run-request-constraint-only",
      now: () => new Date("2026-04-28T02:00:00.000Z")
    });

    const input = validInput(artifactPath);
    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: {
        ...input,
        constraints: {
          ...input.constraints,
          allow_shell_exec: false
        }
      }
    });

    expect(created.json()).toMatchObject({
      status: "plan_rejected",
      run_id: "run-request-constraint-only"
    });
    expect(created.json().reasons[0]).toContain("capability shell_exec is not available for this target/request");
  });

  it("returns artifact_invalid when artifact type does not match target flash profile", async () => {
    server = buildRuntimeServer({
      rootDir,
      adapters: new FakeAdapterRegistry(),
      targetProfiles: [targetProfile()]
    });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: {
        ...validInput(artifactPath),
        artifact: {
          path: artifactPath,
          type: "zip"
        }
      }
    });

    expect(created.json()).toEqual({
      status: "artifact_invalid",
      target: "board-01",
      reasons: ["artifact type zip does not match target flash artifact_type firmware_img"],
      missing_info: [],
      suggested_next: "Provide a readable local artifact file path."
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

    const result = await server.app.inject({ method: "GET", url: "/api/runs/run-bad-plan/result" });
    expect(result.json()).toMatchObject({
      run_id: "run-bad-plan",
      status: "failed",
      summary: "run failed; review event stream and evidence refs for details"
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

function targetProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    target_id: "board-01",
    connections: {
      serial: {
        port: "/dev/ttyUSB0",
        baud: 115200
      },
      adb: {
        device_id: "ABC123"
      }
    },
    flash: {
      method: "fastboot",
      artifact_type: "firmware_img",
      partition: "boot"
    },
    target_hints: {
      boot_markers: ["Booting Linux", "boot completed"],
      fail_patterns: ["kernel panic", "kernel oops"]
    },
    safety: {
      allow_flash: true,
      allow_reboot: true,
      allow_shell_exec: true,
      allow_power_cycle: false
    },
    ...overrides
  };
}

function capabilityAvailability(capabilities: Array<{ name: string; available: boolean }>): Record<string, boolean> {
  return Object.fromEntries(capabilities.map(capability => [capability.name, capability.available]));
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

function twoFailurePlan(): Plan {
  return {
    plan_id: "plan-two-failures",
    estimated_duration_sec: 120,
    steps: [
      {
        id: "step-nonfatal",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/nonfatal",
          expected_exit_code: 0
        },
        timeout_sec: 30,
        on_failure: "continue"
      },
      {
        id: "step-fatal",
        capability: "shell_exec",
        condition: "always",
        input: {
          command: "/vendor/bin/fatal",
          expected_exit_code: 0
        },
        timeout_sec: 30
      }
    ],
    success_criteria: ["both shell commands pass"],
    failure_signals: ["shell command failure"],
    evidence_policy: {
      always: [],
      on_success: [],
      on_failure: ["adb:step-nonfatal", "adb:step-fatal"]
    }
  };
}

function duplicateRuleMatchedPlan(): Plan {
  return {
    plan_id: "plan-duplicate-rule-match",
    estimated_duration_sec: 120,
    steps: [
      {
        id: "step-watch-1",
        capability: "watch_serial",
        condition: "always",
        input: {
          duration_sec: 10,
          patterns: ["service timeout"]
        },
        timeout_sec: 10,
        on_failure: "continue"
      },
      {
        id: "step-watch-2",
        capability: "watch_serial",
        condition: "always",
        input: {
          duration_sec: 10,
          patterns: ["service timeout"]
        },
        timeout_sec: 10,
        on_failure: "continue"
      }
    ],
    success_criteria: ["serial observation finished"],
    failure_signals: ["service timeout"],
    evidence_policy: {
      always: ["serial:full"],
      on_success: [],
      on_failure: ["serial:full"]
    }
  };
}

function runEvent(type: EventType, severity: EventSeverity): RunEvent {
  return {
    seq: 1,
    run_id: "run-001",
    time: "2026-04-28T00:00:00.000Z",
    elapsed_sec: 1,
    type,
    severity,
    source: "rule_engine" satisfies EventSource,
    summary: `${type} ${severity}`
  };
}

function taskPlannerOutput(plan: Plan): Record<string, unknown> {
  return {
    status: "planned",
    validation_intent: {
      intent_id: "intent-001",
      feature_area: "boot",
      confidence: 0.8,
      matched_scenarios: [{ name: "boot", reason: "boot validation request" }],
      expected_behavior: ["device boots and adb returns"],
      risk_focus: ["panic", "adb offline"],
      suggested_actions: ["execute validation plan"],
      observe: ["serial", "adb"],
      evidence_need: ["serial log", "adb command output"],
      pass_fail: ["smoke test exits 0"],
      assumptions: [],
      missing_info: []
    },
    plan,
    missing_info: [],
    assumptions: []
  };
}

function yamlSingleQuotedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "''");
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
