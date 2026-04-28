#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RuntimeHttpClient } from "./runtime-client.js";
import { buildMcpServer } from "./server.js";

export { buildMcpServer } from "./server.js";
export { createToolHandlers, MCP_TOOL_NAMES, registerArtifactValidationTools } from "./tools.js";
export { RuntimeHttpClient } from "./runtime-client.js";

async function main(): Promise<void> {
  const server = buildMcpServer({
    client: new RuntimeHttpClient()
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    console.error("artifact-validation MCP server failed", error);
    process.exit(1);
  });
}
