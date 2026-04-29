#!/usr/bin/env node
// Embed Agent MCP Server — stdio transport via @modelcontextprotocol/sdk

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_TOOLS } from "./index.js";

async function main() {
  const server = new McpServer({
    name: "embed-agent",
    version: "0.0.0",
  });

  // Register all 9 tools
  for (const tool of MCP_TOOLS) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ status: "ok" }) }],
    }));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
