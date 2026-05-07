import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveServerRuntimeLayout } from "../src/server-start.js";

describe("resolveServerRuntimeLayout", () => {
  it("uses repository defaults when no packaged runtime is configured", () => {
    const cliModulePath = "/workspace/embed-Agent/apps/cli/dist/server-start.js";
    const layout = resolveServerRuntimeLayout(cliModulePath, {});

    expect(layout.cliDir).toBe("/workspace/embed-Agent/apps/cli/dist");
    expect(layout.serverCwd).toBe("/workspace/embed-Agent");
    expect(layout.serverEntry).toBe("/workspace/embed-Agent/apps/http-server/dist/main.js");
    expect(layout.defaultDataDir).toBe("/workspace/embed-Agent/.embed-agent");
    expect(layout.defaultWebDist).toBe("/workspace/embed-Agent/apps/webui/dist");
  });

  it("switches to packaged runtime paths when installer env vars are present", () => {
    const cliModulePath = "/install/resources/desktop-runtime/server/node_modules/@embed-agent/cli/dist/server-start.js";
    const runtimeRoot = "/install/resources/desktop-runtime";
    const layout = resolveServerRuntimeLayout(cliModulePath, {
      EMBED_AGENT_RUNTIME_ROOT: runtimeRoot,
      EMBED_AGENT_SERVER_ENTRY: path.join(runtimeRoot, "server", "dist", "main.js"),
      EMBED_AGENT_WEB_DIST: path.join(runtimeRoot, "webui"),
      EMBED_AGENT_DATA: "/Users/test/AppData/Local/Embed Agent/data",
      EMBED_AGENT_NODE_BINARY: "/install/embed-agent-node-x86_64-pc-windows-msvc.exe",
    });

    expect(layout.serverCwd).toBe(runtimeRoot);
    expect(layout.serverEntry).toBe(path.join(runtimeRoot, "server", "dist", "main.js"));
    expect(layout.defaultWebDist).toBe(path.join(runtimeRoot, "webui"));
    expect(layout.defaultDataDir).toBe("/Users/test/AppData/Local/Embed Agent/data");
    expect(layout.nodeBinary).toBe("/install/embed-agent-node-x86_64-pc-windows-msvc.exe");
  });
});
