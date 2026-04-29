import { describe, expect, it } from "vitest";
import { argvPathToFileHref, isDirectCliExecution } from "../src/index.js";

describe("CLI entrypoint detection", () => {
  it("matches Windows absolute script paths", () => {
    const scriptPath = "C:\\Users\\tester\\embed-Agent\\apps\\cli\\dist\\index.js";
    const importMetaUrl = "file:///C:/Users/tester/embed-Agent/apps/cli/dist/index.js";

    expect(argvPathToFileHref(scriptPath, "win32")).toBe(importMetaUrl);
    expect(isDirectCliExecution(importMetaUrl, scriptPath, "win32")).toBe(true);
  });

  it("returns false when argv[1] is missing", () => {
    expect(isDirectCliExecution("file:///tmp/index.js", undefined)).toBe(false);
  });
});
