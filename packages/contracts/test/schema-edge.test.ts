import { describe, it, expect } from "vitest";
import { TargetProfileSchema, LLMConfigSchema, HookConfigSchema } from "../src/schemas.js";

describe("Schema edge cases", () => {
  it("TargetProfile: should reject missing safety", () => {
    const r = TargetProfileSchema.safeParse({ target_id: "t", connections: {} });
    expect(r.success).toBe(false);
  });

  it("TargetProfile: should accept custom_command flash method", () => {
    const r = TargetProfileSchema.safeParse({
      target_id: "t", connections: {},
      flash: { method: "custom_command", artifact_type: "img" },
      safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
    });
    expect(r.success).toBe(true);
  });

  it("LLMConfig: should reject missing observer_policy", () => {
    const r = LLMConfigSchema.safeParse({
      default_provider: "anthropic", providers: {},
    });
    expect(r.success).toBe(false);
  });

  it("HookConfig: should reject negative timeout", () => {
    const r = HookConfigSchema.safeParse({
      hooks: [{ name: "h", on: "PreRunStart", command: "echo", timeout: -1 }],
    });
    expect(r.success).toBe(false);
  });

  it("HookConfig: should reject invalid hook point", () => {
    const r = HookConfigSchema.safeParse({
      hooks: [{ name: "h", on: "InvalidPoint", command: "echo", timeout: 5 }],
    });
    expect(r.success).toBe(false);
  });

  it("HookConfig: should accept empty hooks array", () => {
    const r = HookConfigSchema.safeParse({ hooks: [] });
    expect(r.success).toBe(true);
  });
});
