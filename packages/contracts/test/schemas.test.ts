import { describe, expect, it } from "vitest";
import {
  AgentReplySchema,
  EventTypeSchema,
  EvidenceIndexSchema,
  InterveneRunInputSchema,
  ObserverIntentSchema,
  PlanSchema,
  PublicErrorResponseSchema,
  RunStateSchema,
  ValidateArtifactInputSchema,
  ValidateArtifactRejectedResponseSchema,
  WatchRunResponseSchema
} from "../src/index.js";

describe("P0 contract schemas", () => {
  it("accepts the validate_artifact input shape with adb_shell test_hint", () => {
    const parsed = ValidateArtifactInputSchema.parse({
      context: {
        task: "verify boot crash fix",
        what_changed: "changed init service ordering",
        expected: "device boots and adb returns",
        concerns: ["kernel panic", "adb offline"],
        test_hint: {
          kind: "adb_shell",
          command: "/vendor/bin/smoke_test",
          timeout_sec: 60,
          expected_exit_code: 0
        }
      },
      artifact: {
        path: "/builds/firmware.img",
        type: "firmware_img"
      },
      target: "board-01",
      constraints: {
        max_duration_sec: 600,
        allow_flash: true,
        allow_shell_exec: true
      }
    });

    expect(parsed.context.test_hint?.kind).toBe("adb_shell");
  });

  it("rejects validate_artifact when required planning context is missing", () => {
    expect(() =>
      ValidateArtifactInputSchema.parse({
        context: {
          task: "verify boot"
        },
        artifact: {
          path: "/builds/firmware.img",
          type: "firmware_img"
        },
        target: "board-01",
        constraints: {
          max_duration_sec: 600
        }
      })
    ).toThrow();
  });

  it("rejects adb_shell test_hint without a command", () => {
    expect(() =>
      ValidateArtifactInputSchema.parse({
        context: {
          task: "verify boot",
          expected: "adb returns",
          test_hint: {
            kind: "adb_shell"
          }
        },
        artifact: {
          path: "/builds/firmware.img",
          type: "firmware_img"
        },
        target: "board-01",
        constraints: {
          max_duration_sec: 600
        }
      })
    ).toThrow();
  });

  it("keeps clarification_needed separate from run states", () => {
    expect(RunStateSchema.safeParse("planning").success).toBe(true);
    expect(RunStateSchema.safeParse("clarification_needed").success).toBe(false);

    const rejected = ValidateArtifactRejectedResponseSchema.parse({
      status: "clarification_needed",
      reasons: ["missing test entry"],
      missing_info: ["context.test_hint.command"],
      suggested_next: "provide an adb shell smoke command"
    });

    expect(rejected.status).toBe("clarification_needed");
  });

  it("accepts a capability-level plan without target connection details", () => {
    const plan = PlanSchema.parse({
      plan_id: "plan-001",
      intent_ref: "intent-001",
      estimated_duration_sec: 360,
      steps: [
        {
          id: "step-1",
          capability: "watch_serial",
          condition: "always",
          input: {
            duration_sec: 180,
            patterns: ["kernel panic", "boot completed"]
          },
          timeout_sec: 180,
          on_failure: "collect_and_fail"
        }
      ],
      success_criteria: ["boot completed", "adb online"],
      failure_signals: ["kernel panic"],
      evidence_policy: {
        always: ["timeline", "events"],
        on_failure: ["serial_last_window", "logcat"]
      }
    });

    expect(plan.steps[0]?.capability).toBe("watch_serial");
  });

  it("rejects unregistered event types such as intent_failed", () => {
    expect(EventTypeSchema.safeParse("observer_intent").success).toBe(true);
    expect(EventTypeSchema.safeParse("intent_failed").success).toBe(false);
  });

  it("accepts observer intents with bounded requested actions", () => {
    const intent = ObserverIntentSchema.parse({
      intent: "collect_more",
      reason: "serial shows init timeout and adb is offline",
      confidence: 0.82,
      requested_actions: [
        {
          capability: "collect_logs",
          input: {
            items: ["serial_last_window"]
          }
        }
      ],
      report_to_caller: false
    });

    expect(intent.requested_actions).toHaveLength(1);
  });

  it("rejects observer intent confidence outside 0..1", () => {
    expect(() =>
      ObserverIntentSchema.parse({
        intent: "continue",
        reason: "no fatal event",
        confidence: 1.2,
        requested_actions: [],
        report_to_caller: false
      })
    ).toThrow();
  });

  it("accepts watch_run responses with event cursor data", () => {
    const response = WatchRunResponseSchema.parse({
      run_id: "run-001",
      status: "running",
      events: [
        {
          seq: 42,
          run_id: "run-001",
          time: "2026-04-28T10:01:42+08:00",
          elapsed_sec: 42,
          type: "rule_matched",
          severity: "error",
          source: "rule_engine",
          step_id: "step-2",
          summary: "kernel panic matched on serial",
          payload: {
            pattern: "kernel panic"
          },
          evidence_refs: ["serial:last-200-lines"]
        }
      ],
      next_after_seq: 42
    });

    expect(response.events[0]?.evidence_refs).toContain("serial:last-200-lines");
  });

  it("accepts evidence index and final agent reply shapes", () => {
    const evidence = EvidenceIndexSchema.parse({
      run_id: "run-001",
      partial: true,
      updated_at: "2026-04-28T10:01:42+08:00",
      root_path: "/var/artifact-validation/runs/run-001",
      refs: [
        {
          ref: "serial:last-200-lines",
          kind: "window",
          path: "snapshots/serial-last-200-lines.log",
          available: true,
          source_ref: "serial:full"
        }
      ],
      key_events: [
        {
          seq: 42,
          summary: "kernel panic matched on serial",
          evidence_refs: ["serial:last-200-lines"]
        }
      ]
    });

    const reply = AgentReplySchema.parse({
      run_id: "run-001",
      status: "failed",
      summary: "boot failed after serial kernel panic",
      confidence: 0.86,
      key_evidence: evidence.key_events,
      suggested_next: "inspect init service ordering",
      evidence_path: evidence.root_path,
      report_path: "/var/artifact-validation/runs/run-001/report.json"
    });

    expect(reply.key_evidence[0]?.summary).toContain("kernel panic");
  });

  it("accepts public error and intervention response inputs", () => {
    expect(
      PublicErrorResponseSchema.parse({
        status: "error",
        error_code: "run_not_found",
        message: "run run-001 does not exist"
      }).error_code
    ).toBe("run_not_found");

    expect(
      InterveneRunInputSchema.parse({
        run_id: "run-001",
        action: "add_instruction",
        instruction: "preserve serial last window",
        reason: "human debugging hint"
      }).action
    ).toBe("add_instruction");
  });

  it("rejects add_instruction intervention without instruction text", () => {
    expect(() =>
      InterveneRunInputSchema.parse({
        run_id: "run-001",
        action: "add_instruction",
        reason: "human debugging hint"
      })
    ).toThrow();
  });
});
