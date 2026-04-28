import { describe, expect, it } from "vitest";
import type {
  GetRunEventsResponse,
  InterveneRunResponse,
  RunStatusResponse,
  ValidateArtifactResponse
} from "@artifact-validation/contracts";
import { createCliProgram, type CliRuntimeClient } from "../src/index.js";
import type { RuntimeClientResult } from "@artifact-validation/runtime-client";

describe("CLI thin adapter", () => {
  it("exposes run-level commands without device_exec", () => {
    const program = createCliProgram({ client: fakeClient({}) });

    expect(program.commands.map(command => command.name())).toEqual([
      "validate",
      "status",
      "watch",
      "events",
      "evidence",
      "result",
      "cancel",
      "pause",
      "resume",
      "intervene",
      "capabilities"
    ]);
    expect(program.commands.map(command => command.name())).not.toContain("device_exec");
  });

  it("validates JSON input and calls validate_artifact through the Runtime client", async () => {
    const cli = createHarness({
      readFile: async () => JSON.stringify(validValidateArtifactInput()),
      client: fakeClient({
        validateArtifact: async input => {
          expect(input.target).toBe("board-01");
          return ok<ValidateArtifactResponse>({
            status: "accepted",
            run_id: "run-001",
            target: input.target,
            state: "planning",
            evidence_path: "/tmp/runs/run-001"
          });
        }
      })
    });

    await cli.parse(["validate", "--input", "/tmp/request.json"]);

    expect(cli.stderr).toEqual([]);
    expect(cli.exitCodes).toEqual([]);
    expect(JSON.parse(cli.stdout.join(""))).toEqual({
      status: "accepted",
      run_id: "run-001",
      target: "board-01",
      state: "planning",
      evidence_path: "/tmp/runs/run-001"
    });
  });

  it("prints Runtime public errors to stderr and sets a non-zero exit code", async () => {
    const cli = createHarness({
      client: fakeClient({
        getRunStatus: async () => ({
          ok: false,
          error: {
            status: "error",
            error_code: "run_not_found",
            message: "run run-missing was not found"
          }
        })
      })
    });

    await cli.parse(["status", "run-missing"]);

    expect(cli.stdout).toEqual([]);
    expect(cli.exitCodes).toEqual([1]);
    expect(JSON.parse(cli.stderr.join(""))).toEqual({
      status: "error",
      error_code: "run_not_found",
      message: "run run-missing was not found"
    });
  });

  it("implements watch by combining Runtime event and status reads", async () => {
    const calls: string[] = [];
    const cli = createHarness({
      client: fakeClient({
        getRunEvents: async input => {
          calls.push(`events:${input.after_seq}:${input.limit}:${input.types?.join(",") ?? ""}`);
          return ok<GetRunEventsResponse>({
            run_id: input.run_id,
            events: [],
            next_after_seq: 9,
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
            elapsed_sec: 5,
            last_event_seq: 9,
            evidence_path: "/tmp/runs/run-001"
          });
        }
      })
    });

    await cli.parse(["watch", "run-001", "--after-seq", "7", "--limit", "2", "--types", "rule_matched,observer_intent"]);

    expect(calls).toEqual(["events:7:2:rule_matched,observer_intent", "status:run-001"]);
    expect(JSON.parse(cli.stdout.join(""))).toEqual({
      run_id: "run-001",
      status: "running",
      events: [],
      next_after_seq: 9
    });
  });

  it("passes event type filters through the events command", async () => {
    let capturedTypes: string[] | undefined;
    const cli = createHarness({
      client: fakeClient({
        getRunEvents: async input => {
          capturedTypes = input.types;
          return ok<GetRunEventsResponse>({
            run_id: input.run_id,
            events: [],
            next_after_seq: 0,
            has_more: false
          });
        }
      })
    });

    await cli.parse(["events", "run-001", "--types", "step_failed,step_timeout"]);

    expect(capturedTypes).toEqual(["step_failed", "step_timeout"]);
  });

  it("validates add_instruction intervention input before forwarding", async () => {
    const cli = createHarness({
      client: fakeClient({
        interveneRun: async input => {
          expect(input).toEqual({
            run_id: "run-001",
            action: "add_instruction",
            instruction: "collect more logs"
          });
          return ok<InterveneRunResponse>({
            run_id: input.run_id,
            accepted: true,
            action: input.action,
            status: "running"
          });
        }
      })
    });

    await cli.parse(["intervene", "run-001", "--action", "add_instruction", "--instruction", "collect more logs"]);

    expect(cli.stderr).toEqual([]);
    expect(JSON.parse(cli.stdout.join(""))).toMatchObject({
      run_id: "run-001",
      accepted: true,
      action: "add_instruction"
    });
  });

  it("reports invalid validate input without calling Runtime", async () => {
    const cli = createHarness({
      readFile: async () => "{not json",
      client: fakeClient({
        validateArtifact: async () => {
          throw new Error("validateArtifact should not be called");
        }
      })
    });

    await cli.parse(["validate", "--input", "/tmp/request.json"]);

    expect(cli.stdout).toEqual([]);
    expect(cli.exitCodes).toEqual([1]);
    expect(JSON.parse(cli.stderr.join(""))).toMatchObject({
      status: "error",
      error_code: "invalid_request"
    });
  });

  it("reports unreadable validate input files without calling Runtime", async () => {
    const cli = createHarness({
      readFile: async () => {
        throw new Error("ENOENT");
      },
      client: fakeClient({
        validateArtifact: async () => {
          throw new Error("validateArtifact should not be called");
        }
      })
    });

    await cli.parse(["validate", "--input", "/tmp/missing.json"]);

    expect(cli.stdout).toEqual([]);
    expect(cli.exitCodes).toEqual([1]);
    expect(JSON.parse(cli.stderr.join(""))).toMatchObject({
      status: "error",
      error_code: "invalid_request",
      message: expect.stringContaining("failed to read input file")
    });
  });

  it("reports validate input schema errors without calling Runtime", async () => {
    const cli = createHarness({
      readFile: async () => JSON.stringify({ context: { task: "missing required fields" } }),
      client: fakeClient({
        validateArtifact: async () => {
          throw new Error("validateArtifact should not be called");
        }
      })
    });

    await cli.parse(["validate", "--input", "/tmp/request.json"]);

    expect(cli.stdout).toEqual([]);
    expect(cli.exitCodes).toEqual([1]);
    expect(JSON.parse(cli.stderr.join(""))).toMatchObject({
      status: "error",
      error_code: "invalid_request",
      message: expect.stringContaining("validate_artifact input is invalid")
    });
  });
});

function createHarness(options: { client: CliRuntimeClient; readFile?: (path: string) => Promise<string> }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const program = createCliProgram({
    client: options.client,
    io: {
      readFile: options.readFile,
      writeStdout: text => stdout.push(text),
      writeStderr: text => stderr.push(text),
      setExitCode: code => exitCodes.push(code)
    }
  });
  return {
    stdout,
    stderr,
    exitCodes,
    parse: (args: string[]) => program.parseAsync(args, { from: "user" })
  };
}

function fakeClient(overrides: Partial<CliRuntimeClient>): CliRuntimeClient {
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
