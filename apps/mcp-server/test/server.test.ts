import { describe, it, expect } from "vitest";
import { createMcpServer, type McpMessage } from "../src/server.js";
import { ValidateArtifactInput, GetRunStatusInput, TOOL_DEFINITIONS, type ToolHandlers } from "../src/tools.js";

describe("MCP Server", () => {
  it("has 9 tool definitions", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(9);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain("validate_artifact");
    expect(names).toContain("get_run_status");
    expect(names).toContain("watch_run");
    expect(names).toContain("get_run_events");
    expect(names).toContain("get_evidence");
    expect(names).toContain("get_run_result");
    expect(names).toContain("intervene_run");
    expect(names).toContain("cancel_run");
    expect(names).toContain("get_target_capabilities");
  });

  it("ValidateArtifactInput accepts valid MCP input", () => {
    const result = ValidateArtifactInput.safeParse({
      context: { task: "Check boot", expected: "Device boots normally" },
      artifact: { path: "/tmp/test.img", type: "firmware" },
      target: "t1",
    });
    expect(result.success).toBe(true);
  });

  it("ValidateArtifactInput rejects missing context", () => {
    const result = ValidateArtifactInput.safeParse({
      artifact: { path: "/tmp/test.img", type: "firmware" },
      target: "t1",
    });
    expect(result.success).toBe(false);
  });

  it("GetRunStatusInput validates run_id", () => {
    const result = GetRunStatusInput.safeParse({ run_id: "r1" });
    expect(result.success).toBe(true);
  });

  it("responds to initialize with server capabilities", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);

    await transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "embed-agent", version: "1.0.0" },
      },
    });
  });

  it("responds to ping after initialization", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);

    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("returns method-not-found for unsupported requests", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);

    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "resources/list" });

    expect(sent).toEqual([{
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found: resources/list" },
    }]);
  });

  it("marks tool execution failures as MCP tool errors", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);

    await transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });

    expect(sent[0]?.result).toMatchObject({ isError: true });
  });
});

function createFakeTransport(): {
  sent: { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } }[];
  transport: {
    onmessage?: (msg: McpMessage) => void | Promise<void>;
    start(): Promise<void>;
    send(msg: { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } }): Promise<void>;
  };
} {
  const sent: { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } }[] = [];
  return {
    sent,
    transport: {
      async start() {},
      async send(msg) {
        sent.push(msg);
      },
    },
  };
}

function createHandlers(): ToolHandlers {
  return {
    validate_artifact: async () => ({ status: "clarification_needed" }),
    get_run_status: async () => null,
    watch_run: async (input) => ({ run_id: input.run_id, status: "unknown", events: [], next_after_seq: 0 }),
    get_run_events: async (input) => ({ run_id: input.run_id, events: [], next_after_seq: 0, has_more: false }),
    get_evidence: async () => ({ available: false }),
    get_run_result: async (input) => ({ run_id: input.run_id, state: "unknown", result_available: false }),
    intervene_run: async (input) => ({ run_id: input.run_id, accepted: false, action: input.action }),
    cancel_run: async (input) => ({ run_id: input.run_id, accepted: false, status: "error" }),
    get_target_capabilities: async (input) => ({
      target: input.target,
      runtime_state: { state: "unknown", serial: "unknown", adb: "unknown", fastboot: "unknown" },
      capabilities: [],
    }),
  };
}
