import { describe, it, expect } from "vitest";
import { ValidateArtifactInput, GetRunStatusInput, TOOL_DEFINITIONS } from "../src/tools.js";

describe("MCP Server", () => {
  it("has 10 tool definitions", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(10);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain("list_targets");
    expect(names).toContain("validate_artifact");
    expect(names).toContain("get_run_status");
  });

  it("ValidateArtifactInput accepts flat format", () => {
    const result = ValidateArtifactInput.safeParse({
      target: "esp32", artifact_path: "/tmp/test.img", artifact_type: "firmware", expected: "Boot",
    });
    expect(result.success).toBe(true);
  });

  it("ValidateArtifactInput rejects missing required", () => {
    const result = ValidateArtifactInput.safeParse({ target: "esp32" });
    expect(result.success).toBe(false);
  });

  it("GetRunStatusInput accepts run_id", () => {
    const result = GetRunStatusInput.safeParse({ run_id: "r1" });
    expect(result.success).toBe(true);
  });
});
