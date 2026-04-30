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

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);

const JSON_RPC_ERRORS = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface McpMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpTransport {
  onmessage?: (msg: McpMessage) => void | Promise<void>;
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

    try {
      if (typeof msg.method !== "string") {
        await sendError(transport, msg, JSON_RPC_ERRORS.invalidRequest, "Invalid request: missing method");
        return;
      }

      if (msg.method === "initialize") {
        await sendResult(transport, msg, {
          protocolVersion: negotiateProtocolVersion(msg),
          capabilities: { tools: {} },
          serverInfo: { name: "embed-agent", version: "1.0.0" },
        });
        return;
      }

      // notifications/initialized and other notifications do not need a response.
      if (!hasRequestId(msg)) return;

      if (msg.method === "ping") {
        await sendResult(transport, msg, {});
        return;
      }

      if (msg.method === "tools/list") {
        await sendResult(transport, msg, { tools: TOOL_DEFINITIONS });
        return;
      }

      if (msg.method === "tools/call") {
        await handleToolCall(handlers, transport, msg);
        return;
      }

      await sendError(transport, msg, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${msg.method}`);
    } catch (e) {
      await sendError(transport, msg, JSON_RPC_ERRORS.internalError, (e as Error).message);
    }
  };

  return {
    close: () => { closed = true; },
  };
}

async function handleToolCall(
  handlers: ToolHandlers,
  transport: McpTransport,
  msg: McpMessage,
): Promise<void> {
  const params = isRecord(msg.params) ? msg.params : {};
  const name = typeof params["name"] === "string" ? params["name"] : undefined;
  const input = isRecord(params["arguments"]) ? params["arguments"] : {};

  if (!name) {
    await sendError(transport, msg, JSON_RPC_ERRORS.invalidParams, "Invalid params: tools/call requires params.name");
    return;
  }

  try {
    const result = await dispatchTool(handlers, name, input);
    await sendResult(transport, msg, createToolResult(result));
  } catch (e) {
    // Return tool execution failures as MCP tool results, not transport-level JSON-RPC errors.
    const errMsg = (e as Error).message;
    const errorResult = errMsg.includes("Zod")
      ? { status: "error", error_code: "invalid_request", message: errMsg }
      : { status: "error", error_code: "internal_error", message: errMsg };
    await sendResult(transport, msg, createToolResult(errorResult, true));
  }
}

function createToolResult(value: unknown, isError = false): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function sendResult(transport: McpTransport, msg: McpMessage, result: unknown): Promise<void> {
  if (!hasRequestId(msg)) return;
  await transport.send({ jsonrpc: "2.0", id: msg.id, result });
}

async function sendError(transport: McpTransport, msg: McpMessage, code: number, message: string): Promise<void> {
  if (!hasRequestId(msg)) return;
  await transport.send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
}

function hasRequestId(msg: McpMessage): msg is McpMessage & { id: unknown } {
  return msg.id !== undefined;
}

function negotiateProtocolVersion(msg: McpMessage): string {
  const requested = isRecord(msg.params) && typeof msg.params["protocolVersion"] === "string"
    ? msg.params["protocolVersion"]
    : undefined;
  return requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
