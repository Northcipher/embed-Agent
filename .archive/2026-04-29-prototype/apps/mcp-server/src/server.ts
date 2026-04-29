import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerArtifactValidationTools, type RuntimeClientPort } from "./tools.js";

export type BuildMcpServerOptions = {
  client: RuntimeClientPort;
};

export function buildMcpServer(options: BuildMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "artifact-validation-agent",
      version: "0.0.0"
    },
    {
      instructions:
        "Use this server to validate artifacts through Runtime-owned runs. Do not expect MCP to execute raw device commands; use run-level tools and evidence queries only."
    }
  );

  registerArtifactValidationTools(server, options.client);
  return server;
}
