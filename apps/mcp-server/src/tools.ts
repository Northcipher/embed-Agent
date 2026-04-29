import {
  CancelRunInputSchema,
  CancelRunResponseSchema,
  GetEvidenceInputSchema,
  GetRunEventsInputSchema,
  GetRunEventsResponseSchema,
  GetRunResultInputSchema,
  GetTargetCapabilitiesInputSchema,
  GetTargetCapabilitiesResponseSchema,
  InterveneRunInputSchema,
  InterveneRunResponseSchema,
  RunStatusInputSchema,
  RunStatusResponseSchema,
  ValidateArtifactInputSchema,
  WatchRunInputSchema,
  WatchRunResponseSchema
} from "@artifact-validation/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toMcpResult } from "./mcp-result.js";
import {
  GetEvidenceMcpOutputSchema,
  GetRunResultMcpOutputSchema,
  ValidateArtifactMcpOutputSchema
} from "./output-schemas.js";
import { RuntimeHttpClient } from "./runtime-client.js";

export const MCP_TOOL_NAMES = [
  "validate_artifact",
  "get_run_status",
  "watch_run",
  "get_run_events",
  "get_evidence",
  "get_run_result",
  "intervene_run",
  "cancel_run",
  "get_target_capabilities"
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type RuntimeClientPort = Pick<
  RuntimeHttpClient,
  | "validateArtifact"
  | "getRunStatus"
  | "watchRun"
  | "getRunEvents"
  | "getEvidence"
  | "getRunResult"
  | "interveneRun"
  | "cancelRun"
  | "getTargetCapabilities"
>;

export type ToolHandlers = Record<McpToolName, (input: unknown) => Promise<CallToolResult>>;

export function createToolHandlers(client: RuntimeClientPort): ToolHandlers {
  return {
    validate_artifact: async input => {
      const parsed = ValidateArtifactInputSchema.parse(input);
      return toMcpResult(await client.validateArtifact(parsed));
    },
    get_run_status: async input => {
      const parsed = RunStatusInputSchema.parse(input);
      return toMcpResult(await client.getRunStatus(parsed));
    },
    watch_run: async input => {
      const parsed = WatchRunInputSchema.parse(input);
      return toMcpResult(await client.watchRun(parsed));
    },
    get_run_events: async input => {
      const parsed = GetRunEventsInputSchema.parse(input);
      return toMcpResult(await client.getRunEvents(parsed));
    },
    get_evidence: async input => {
      const parsed = GetEvidenceInputSchema.parse(input);
      return toMcpResult(await client.getEvidence(parsed));
    },
    get_run_result: async input => {
      const parsed = GetRunResultInputSchema.parse(input);
      return toMcpResult(await client.getRunResult(parsed));
    },
    intervene_run: async input => {
      const parsed = InterveneRunInputSchema.parse(input);
      return toMcpResult(await client.interveneRun(parsed));
    },
    cancel_run: async input => {
      const parsed = CancelRunInputSchema.parse(input);
      return toMcpResult(await client.cancelRun(parsed));
    },
    get_target_capabilities: async input => {
      const parsed = GetTargetCapabilitiesInputSchema.parse(input);
      return toMcpResult(await client.getTargetCapabilities(parsed));
    }
  };
}

export function registerArtifactValidationTools(server: McpServer, client: RuntimeClientPort): void {
  const handlers = createToolHandlers(client);

  server.registerTool(
    "validate_artifact",
    {
      title: "Validate Artifact",
      description: "Start artifact validation through the Runtime Server. Does not execute device commands in MCP.",
      inputSchema: ValidateArtifactInputSchema,
      outputSchema: ValidateArtifactMcpOutputSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handlers.validate_artifact
  );

  server.registerTool(
    "get_run_status",
    {
      title: "Get Run Status",
      description: "Read current Runtime-owned run status.",
      inputSchema: RunStatusInputSchema,
      outputSchema: RunStatusResponseSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.get_run_status
  );

  server.registerTool(
    "watch_run",
    {
      title: "Watch Run",
      description: "Return current run status plus event stream entries after a sequence cursor.",
      inputSchema: WatchRunInputSchema,
      outputSchema: WatchRunResponseSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.watch_run
  );

  server.registerTool(
    "get_run_events",
    {
      title: "Get Run Events",
      description: "Read Runtime event stream entries after a sequence cursor.",
      inputSchema: GetRunEventsInputSchema,
      outputSchema: GetRunEventsResponseSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.get_run_events
  );

  server.registerTool(
    "get_evidence",
    {
      title: "Get Evidence",
      description: "Read evidence index or one evidence reference from the Runtime Evidence Store.",
      inputSchema: GetEvidenceInputSchema,
      outputSchema: GetEvidenceMcpOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.get_evidence
  );

  server.registerTool(
    "get_run_result",
    {
      title: "Get Run Result",
      description: "Read the final or unavailable run result from Runtime.",
      inputSchema: GetRunResultInputSchema,
      outputSchema: GetRunResultMcpOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.get_run_result
  );

  server.registerTool(
    "intervene_run",
    {
      title: "Intervene Run",
      description: "Request an allowed run intervention through Runtime control boundaries.",
      inputSchema: InterveneRunInputSchema,
      outputSchema: InterveneRunResponseSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    handlers.intervene_run
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel Run",
      description: "Cancel a Runtime-owned run.",
      inputSchema: CancelRunInputSchema,
      outputSchema: CancelRunResponseSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.cancel_run
  );

  server.registerTool(
    "get_target_capabilities",
    {
      title: "Get Target Capabilities",
      description: "Read Runtime-reported target capabilities. MCP does not own target connections.",
      inputSchema: GetTargetCapabilitiesInputSchema,
      outputSchema: GetTargetCapabilitiesResponseSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    handlers.get_target_capabilities
  );
}
