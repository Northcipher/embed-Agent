import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ValidateArtifactInput } from "@artifact-validation/contracts";
import {
  createRuntimeServerFromCliOptions,
  demoPlanFromValidateInput,
  parseRuntimeServerCliArgs,
  startRuntimeServer
} from "../src/cli.js";

describe("runtime-server CLI entry", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir !== undefined) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it("parses safe local defaults and explicit startup options", () => {
    expect(parseRuntimeServerCliArgs([], {})).toEqual({
      adapter: "fake",
      demoPlan: false,
      executePlansInline: false,
      host: "127.0.0.1",
      logger: false,
      port: 3456,
      rootDir: ".artifact-agent",
      targetsDir: "configs/targets"
    });

    expect(
      parseRuntimeServerCliArgs(
        [
          "--host",
          "0.0.0.0",
          "--port",
          "4567",
          "--root-dir",
          ".runtime-data",
          "--targets-dir",
          "configs/windows-targets",
          "--adapter",
          "real",
          "--llm-config",
          "configs/llm.yaml",
          "--execute-inline",
          "--demo-plan",
          "--log"
        ],
        {}
      )
    ).toEqual({
      adapter: "real",
      demoPlan: true,
      executePlansInline: true,
      host: "0.0.0.0",
      llmConfigPath: "configs/llm.yaml",
      logger: true,
      port: 4567,
      rootDir: ".runtime-data",
      targetsDir: "configs/windows-targets"
    });
  });

  it("creates a safe fake server that can execute a demo plan through the HTTP API", async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-runtime-cli-"));
    const artifactPath = path.join(rootDir, "firmware.img");
    await writeFile(artifactPath, "fake firmware\n");

    const runtime = await createRuntimeServerFromCliOptions({
      adapter: "fake",
      demoPlan: true,
      executePlansInline: true,
      host: "127.0.0.1",
      logger: false,
      port: 0,
      rootDir,
      targetsDir: undefined
    });

    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/validate-artifact",
      payload: validInput(artifactPath)
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "accepted",
      state: "completed",
      target: "board-01"
    });

    await runtime.app.close();
  });

  it("starts and closes the Fastify listener on an ephemeral local port", async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-runtime-listen-"));

    const started = await startRuntimeServer({
      adapter: "fake",
      demoPlan: false,
      executePlansInline: false,
      host: "127.0.0.1",
      logger: false,
      port: 0,
      rootDir,
      targetsDir: undefined
    });

    expect(started.address).toContain("127.0.0.1");
    await started.close();
  });

  it("does not invent a smoke test step when test_hint is absent", () => {
    const input = validInput("/tmp/firmware.img");
    const plan = demoPlanFromValidateInput({
      ...input,
      context: {
        task: input.context.task,
        what_changed: input.context.what_changed,
        expected: input.context.expected,
        concerns: input.context.concerns
      }
    });

    expect(plan.steps.map(step => step.capability)).not.toContain("shell_exec");
  });

  it("does not add a flash step unless allow_flash is explicitly true", () => {
    const input = validInput("/tmp/firmware.img");
    const plan = demoPlanFromValidateInput({
      ...input,
      constraints: {
        max_duration_sec: input.constraints.max_duration_sec,
        allow_reboot: input.constraints.allow_reboot,
        allow_power_cycle: input.constraints.allow_power_cycle
      }
    });

    expect(plan.steps.map(step => step.capability)).not.toContain("flash");
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
