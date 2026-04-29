import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "../src/index.js";

describe("MCP Tools", () => {
  it("should have 9 tools", () => {
    expect(MCP_TOOLS).toHaveLength(9);
  });

  it("should have unique tool names", () => {
    const names = MCP_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("should have inputSchema for every tool", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("should have required field for validate_artifact", () => {
    const va = MCP_TOOLS.find(t => t.name === "validate_artifact")!;
    expect(va.inputSchema.required).toContain("artifact_path");
    expect(va.inputSchema.required).toContain("target_id");
  });
});
