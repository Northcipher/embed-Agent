import { describe, it, expect } from "vitest";
import {
  TargetProfileSchema,
  LLMConfigSchema,
  HookConfigSchema,
} from "../src/schemas.js";

describe("TargetProfileSchema", () => {
  it("should accept valid minimal profile", () => {
    const result = TargetProfileSchema.safeParse({
      target_id: "board-01",
      connections: {},
      safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
    });
    expect(result.success).toBe(true);
  });

  it("should reject missing required fields", () => {
    const result = TargetProfileSchema.safeParse({ target_id: "board-01" });
    expect(result.success).toBe(false);
  });

  it("should reject invalid flash method", () => {
    const result = TargetProfileSchema.safeParse({
      target_id: "board-01",
      connections: {},
      flash: { method: "invalid", artifact_type: "img" },
      safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
    });
    expect(result.success).toBe(false);
  });
});

describe("LLMConfigSchema", () => {
  it("should accept valid config", () => {
    const result = LLMConfigSchema.safeParse({
      default_provider: "anthropic",
      providers: {
        anthropic: {
          type: "anthropic",
          api_key_env: "ANTHROPIC_API_KEY",
          models: { planner: "sonnet", observer: "haiku", reply: "sonnet" },
          timeout: { planner: 60, observer: 30, reply: 60 },
        },
      },
      observer_policy: {
        debounce_sec: 30,
        max_concurrent_per_run: 1,
        default_checkpoint_interval: 300,
      },
    });
    expect(result.success).toBe(true);
  });

  it("should reject missing observer_policy", () => {
    const result = LLMConfigSchema.safeParse({
      default_provider: "anthropic",
      providers: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("HookConfigSchema", () => {
  it("should accept valid hook config", () => {
    const result = HookConfigSchema.safeParse({
      hooks: [{
        name: "pre-flash-check",
        on: "PreStepExecute",
        command: "./check.sh",
        timeout: 30,
      }],
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid hook point", () => {
    const result = HookConfigSchema.safeParse({
      hooks: [{
        name: "test",
        on: "InvalidPoint",
        command: "./test.sh",
        timeout: 10,
      }],
    });
    expect(result.success).toBe(false);
  });
});
