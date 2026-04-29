#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RuntimeHttpClient } from "./runtime-client.js";
import { buildMcpServer } from "./server.js";

export { buildMcpServer } from "./server.js";
export { createToolHandlers, MCP_TOOL_NAMES, registerArtifactValidationTools } from "./tools.js";
export { RuntimeHttpClient } from "./runtime-client.js";

export function argvPathToFileHref(pathArg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return windowsPathToFileHref(pathArg);
  }
  return pathToFileURL(path.resolve(pathArg)).href;
}

export function isDirectMcpExecution(
  importMetaUrl: string,
  argv1: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (argv1 === undefined) {
    return false;
  }
  return importMetaUrl === argvPathToFileHref(argv1, platform);
}

async function main(): Promise<void> {
  const server = buildMcpServer({
    client: new RuntimeHttpClient()
  });
  await server.connect(new StdioServerTransport());
}

function windowsPathToFileHref(pathArg: string): string {
  const resolved = path.win32.resolve(pathArg);

  if (resolved.startsWith("\\\\")) {
    const [host, ...segments] = resolved.slice(2).split("\\");
    const url = new URL(`file://${host}/`);
    url.pathname = `/${segments.join("/")}`;
    return url.href;
  }

  const url = new URL("file:///");
  url.pathname = resolved.replace(/\\/g, "/");
  return url.href;
}

if (isDirectMcpExecution(import.meta.url, process.argv[1])) {
  main().catch(error => {
    console.error("artifact-validation MCP server failed", error);
    process.exit(1);
  });
}
