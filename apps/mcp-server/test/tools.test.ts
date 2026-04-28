import { describe, expect, it } from "vitest";
import type {
  GetRunEventsResponse,
  RunStatusResponse,
  ValidateArtifactResponse
} from "@artifact-validation/contracts";
import { createToolHandlers, MCP_TOOL_NAMES, type RuntimeClientPort } from "../src/tools.js";
import type { RuntimeClientResult } from "../src/runtime-client.js";

describe("MCP tool handlers", () => {
  it("exposes only run-level P0 tools", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "validate_artifact",
      "get_run_status",
      "watch_run",
      "get_run_events",
      "get_evidence",
      "get_run_result",
      "intervene_run",
      "cancel_run",
      "get_target_capabilities"
    ]);
    expect(MCP_TOOL_NAMES).not.toContain("device_exec");
  });

  it("returns structuredContent and JSON text for successful validate_artifact", async () => {
    const handlers = createToolHandlers(
      fakeRuntimeClient({
        validateArtifact: async input => {
          expect(input.target).toBe("board-01");
          return ok<ValidateArtifactResponse>({
            status: "accepted",
            run_id: "run-001",
            target: "board-01",
            state: "planning",
            evidence_path: "/tmp/runs/run-001"
          });
        }
      })
    );

    const result = await handlers.validate_artifact(validValidateArtifactInput());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      status: "accepted",
      run_id: "run-001",
      target: "board-01",
      state: "planning",
      evidence_path: "/tmp/runs/run-001"
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.structuredContent, null, 2)
      }
    ]);
  });

  it("surfaces Runtime public errors as MCP tool errors", async () => {
    const handlers = createToolHandlers(
      fakeRuntimeClient({
        getRunStatus: async () => ({
          ok: false,
          error: {
            status: "error",
            error_code: "run_not_found",
            message: "run run-missing was not found"
          }
        })
      })
    );

    const result = await handlers.get_run_status({ run_id: "run-missing" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "error",
      error_code: "run_not_found",
      message: "run run-missing was not found"
    });
  });

  it("implements watch_run by combining Runtime status and event stream reads", async () => {
    const calls: string[] = [];
    const handlers = createToolHandlers(
      fakeRuntimeClient({
        getRunEvents: async input => {
          calls.push(`events:${input.after_seq}:${input.limit}:${input.types?.join(",") ?? ""}`);
          return ok<GetRunEventsResponse>({
            run_id: input.run_id,
            events: [],
            next_after_seq: 7,
            has_more: false
          });
        },
        getRunStatus: async input => {
          calls.push(`status:${input.run_id}`);
          return ok<RunStatusResponse>({
            run_id: input.run_id,
            status: "running",
            target: {
              state: "busy",
              current_run_id: input.run_id
            },
            elapsed_sec: 12,
            last_event_seq: 7,
            evidence_path: "/tmp/runs/run-001"
          });
        }
      })
    );

    const result = await handlers.watch_run({ run_id: "run-001", after_seq: 5, limit: 2, types: ["rule_matched"] });

    expect(calls).toEqual(["events:5:2:rule_matched", "status:run-001"]);
    expect(result.structuredContent).toEqual({
      run_id: "run-001",
      status: "running",
      events: [],
      next_after_seq: 7
    });
  });
});

function fakeRuntimeClient(overrides: Partial<RuntimeClientPort>): RuntimeClientPort {
  const notImplemented = async (): Promise<RuntimeClientResult<never>> => ({
    ok: false,
    error: {
      status: "error",
      error_code: "internal_error",
      message: "test client method not implemented"
    }
  });
  return {
    validateArtifact: overrides.validateArtifact ?? notImplemented,
    getRunStatus: overrides.getRunStatus ?? notImplemented,
    getRunEvents: overrides.getRunEvents ?? notImplemented,
    getEvidence: overrides.getEvidence ?? notImplemented,
    getRunResult: overrides.getRunResult ?? notImplemented,
    interveneRun: overrides.interveneRun ?? notImplemented,
    cancelRun: overrides.cancelRun ?? notImplemented,
    getTargetCapabilities: overrides.getTargetCapabilities ?? notImplemented
  };
}

function ok<T>(data: T): RuntimeClientResult<T> {
  return {
    ok: true,
    data
  };
}

function validValidateArtifactInput() {
  return {
    context: {
      task: "验证 boot crash 是否修复",
      what_changed: "调整 init service 启动顺序",
      expected: "设备能启动完成，ADB 能回来",
      concerns: ["kernel panic"],
      test_hint: {
        kind: "adb_shell" as const,
        command: "/vendor/bin/smoke_test",
        timeout_sec: 60,
        expected_exit_code: 0
      }
    },
    artifact: {
      path: "/tmp/firmware.img",
      type: "firmware_img"
    },
    target: "board-01",
    constraints: {
      max_duration_sec: 600,
      allow_flash: true,
      allow_reboot: true
    }
  };
}
