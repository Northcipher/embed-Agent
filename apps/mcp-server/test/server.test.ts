import { describe, it, expect } from "vitest";
import { ValidateArtifactInput, GetRunStatusInput, TOOL_DEFINITIONS } from "../src/tools.js";

describe("MCP Server", () => {
  it("has 9 tool definitions", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(9);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain("validate_artifact");
    expect(names).toContain("get_run_status");
    expect(names).toContain("watch_run");
    expect(names).toContain("get_run_events");
    expect(names).toContain("get_evidence");
    expect(names).toContain("get_run_result");
    expect(names).toContain("intervene_run");
    expect(names).toContain("cancel_run");
    expect(names).toContain("get_target_capabilities");
  });

  it("ValidateArtifactInput accepts valid MCP input", () => {
    const result = ValidateArtifactInput.safeParse({
      context: { task: "Check boot", expected: "Device boots normally" },
      artifact: { path: "/tmp/test.img", type: "firmware" },
      target: "t1",
    });
    expect(result.success).toBe(true);
  });

  it("ValidateArtifactInput rejects missing context", () => {
    const result = ValidateArtifactInput.safeParse({
      artifact: { path: "/tmp/test.img", type: "firmware" },
      target: "t1",
    });
    expect(result.success).toBe(false);
  });

  it("GetRunStatusInput validates run_id", () => {
    const result = GetRunStatusInput.safeParse({ run_id: "r1" });
    expect(result.success).toBe(true);
  });
});
