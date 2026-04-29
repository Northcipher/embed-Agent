import { describe, expect, it } from "vitest";
import { argvPathToFileHref, isDirectMcpExecution } from "../src/index.js";

describe("MCP server entrypoint detection", () => {
  it("matches Windows absolute script paths", () => {
    const scriptPath = "C:\\Users\\tester\\embed-Agent\\apps\\mcp-server\\dist\\index.js";
    const importMetaUrl = "file:///C:/Users/tester/embed-Agent/apps/mcp-server/dist/index.js";

    expect(argvPathToFileHref(scriptPath, "win32")).toBe(importMetaUrl);
    expect(isDirectMcpExecution(importMetaUrl, scriptPath, "win32")).toBe(true);
  });

  it("returns false when argv[1] is missing", () => {
    expect(isDirectMcpExecution("file:///tmp/index.js", undefined)).toBe(false);
  });
});
