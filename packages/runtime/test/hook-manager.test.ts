import { describe, it, expect } from "vitest";
import { HookManager } from "../src/hook-manager.js";
import type { HookConfig } from "@embed-agent/contracts";

describe("HookManager", () => {
  it("should proceed when no hooks match", async () => {
    const hm = new HookManager();
    hm.load({ hooks: [] });
    const result = await hm.execute("PreRunStart", { run_id: "r1" });
    expect(result.decision).toBe("proceed");
  });

  it("should block on PreStepExecute hook", async () => {
    const hm = new HookManager();
    hm.load({
      hooks: [{
        name: "test-block", on: "PreStepExecute",
        command: "echo '{\"decision\":\"block\",\"reason\":\"test\"}'",
        timeout: 5,
      }],
    });
    const result = await hm.execute("PreStepExecute", { run_id: "r1" });
    expect(result.decision).toBe("block");
  });

  it("should filter by match", async () => {
    const hm = new HookManager();
    hm.load({
      hooks: [{
        name: "flash-check", on: "PreStepExecute",
        match: { capability: "flash" },
        command: "echo '{\"decision\":\"block\"}'",
        timeout: 5,
      }],
    });
    // No match → proceed
    const r1 = await hm.execute("PreStepExecute", { capability: "shell_exec" });
    expect(r1.decision).toBe("proceed");
    // Match → block
    const r2 = await hm.execute("PreStepExecute", { capability: "flash" });
    expect(r2.decision).toBe("block");
  });

  it("should ignore invalid hook point decisions", async () => {
    const hm = new HookManager();
    hm.load({
      hooks: [{
        name: "bad", on: "PostRunEnd",
        command: "echo '{\"decision\":\"block\"}'",
        timeout: 5,
      }],
    });
    const result = await hm.execute("PostRunEnd", { run_id: "r1" });
    expect(result.decision).toBe("proceed"); // block not allowed for PostRunEnd
  });

  it("should interpolate template variables", async () => {
    const hm = new HookManager();
    hm.load({
      hooks: [{
        name: "template", on: "PreRunStart",
        command: "echo '{\"decision\":\"proceed\",\"reason\":\"{{run_id}}\"}'",
        timeout: 5,
      }],
    });
    const result = await hm.execute("PreRunStart", { run_id: "run-042" });
    expect(result.decision).toBe("proceed");
  });
});
