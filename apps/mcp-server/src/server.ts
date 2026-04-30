import {
  ValidateArtifactInput,
  GetRunStatusInput,
  WatchRunInput,
  GetRunEventsInput,
  GetEvidenceInput,
  GetRunResultInput,
  InterveneRunInput,
  CancelRunInput,
  GetTargetCapabilitiesInput,
  TOOL_DEFINITIONS,
  type ToolHandlers,
} from "./tools.js";

// --- MCP Server ---

interface McpTransport {
  onmessage?: (msg: { method: string; params?: { name: string; arguments?: Record<string, unknown> }; id?: unknown }) => void;
  start(): Promise<void>;
  send(msg: { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } }): Promise<void>;
}

/**
 * Create and start an MCP server over the given transport.
 * Returns the server handle for shutdown.
 */
export function createMcpServer(handlers: ToolHandlers, transport: McpTransport): { close: () => void } {
  let closed = false;

  transport.onmessage = async (msg) => {
    if (closed) return;

    if (msg.method === "tools/list") {
      await transport.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOL_DEFINITIONS },
      });
    } else if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const input = msg.params?.arguments ?? {};

      try {
        const result = await dispatchTool(handlers, name as string, input);
        await transport.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        });
      } catch (e) {
        await transport.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: (e as Error).message },
        });
      }
    }
  };

  return {
    close: () => { closed = true; },
  };
}

async function dispatchTool(
  handlers: ToolHandlers,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "validate_artifact": {
      const parsed = ValidateArtifactInput.parse(input);
      return handlers.validate_artifact(parsed);
    }
    case "get_run_status": {
      const parsed = GetRunStatusInput.parse(input);
      return handlers.get_run_status(parsed);
    }
    case "watch_run": {
      const parsed = WatchRunInput.parse(input);
      return handlers.watch_run(parsed);
    }
    case "get_run_events": {
      const parsed = GetRunEventsInput.parse(input);
      return handlers.get_run_events(parsed);
    }
    case "get_evidence": {
      const parsed = GetEvidenceInput.parse(input);
      return handlers.get_evidence(parsed);
    }
    case "get_run_result": {
      const parsed = GetRunResultInput.parse(input);
      return handlers.get_run_result(parsed);
    }
    case "intervene_run": {
      const parsed = InterveneRunInput.parse(input);
      return handlers.intervene_run(parsed);
    }
    case "cancel_run": {
      const parsed = CancelRunInput.parse(input);
      return handlers.cancel_run(parsed);
    }
    case "get_target_capabilities": {
      const parsed = GetTargetCapabilitiesInput.parse(input);
      return handlers.get_target_capabilities(parsed);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
