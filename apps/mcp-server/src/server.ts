#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

async function main() {
  const server = new McpServer({ name: "embed-agent", version: "0.0.0" });

  server.registerTool("validate_artifact", {
    description: "Start a validation run",
    inputSchema: { artifact_path: z.string(), target_id: z.string(), expected: z.string() },
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ status: "ok" }) }] }));

  server.registerTool("get_run_status", {
    description: "Get run status",
    inputSchema: { run_id: z.string() },
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ status: "ok" }) }] }));

  server.registerTool("get_run_result", {
    description: "Get final run result",
    inputSchema: { run_id: z.string() },
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ status: "ok" }) }] }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
