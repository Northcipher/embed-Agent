import { describe, it, expect } from "vitest";
import { createMcpServer, type McpMessage } from "../src/server.js";
import { ValidateArtifactInput, GetRunStatusInput, TOOL_DEFINITIONS, type ToolHandlers } from "../src/tools.js";

describe("MCP Server", () => {
  it("has 10 tool definitions", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(10);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain("list_targets");
    expect(names).toContain("validate_artifact");
    expect(names).toContain("get_run_status");
  });

  it("ValidateArtifactInput accepts flat format", () => {
    const result = ValidateArtifactInput.safeParse({
      target: "esp32", artifact_path: "/tmp/test.img", artifact_type: "firmware", expected: "Boot",
    });
    expect(result.success).toBe(true);
  });

  it("ValidateArtifactInput rejects missing required", () => {
    const result = ValidateArtifactInput.safeParse({ target: "esp32" });
    expect(result.success).toBe(false);
  });

  it("responds to initialize with server capabilities", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);
    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "embed-agent", version: "1.0.0" } } });
  });

  it("responds to ping", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);
    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("returns method-not-found for unsupported", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);
    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found: resources/list" } }]);
  });

  it("tool errors return isError", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);
    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "does_not_exist", arguments: {} } });
    expect(sent[0]?.result).toMatchObject({ isError: true });
  });

  it("validate_artifact returns summary+data", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport);
    await transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "validate_artifact", arguments: { target: "t1", artifact_path: "/tmp/a.img", artifact_type: "fw", expected: "Boot" } } });
    const text = (sent[0]?.result as { content: { text: string }[] })?.content?.[0]?.text ?? "";
    expect(text).toContain("accepted");       // summary value
    expect(text).toContain("run_id");          // data field
  });
});

function createFakeTransport() {
  const sent: { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } }[] = [];
  return { sent, transport: { async start() {}, async send(msg: { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } }) { sent.push(msg); } } };
}

function createHandlers(): ToolHandlers {
  return {
    list_targets: async () => ({ summary: "0 targets", data: { targets: [] } }),
    validate_artifact: async () => ({ summary: "accepted", data: { status: "accepted", run_id: "r1" } }),
    get_run_status: async () => ({ summary: "running", data: { run_id: "r1", state: "running", elapsed_sec: 0, last_event_seq: 0, evidence_path: "" } }),
    watch_run: async (input) => ({ summary: "0 events", data: { run_id: input.run_id, state: "running", events: [], next_after_seq: 0 } }),
    get_run_events: async (input) => ({ summary: "0 events", data: { run_id: input.run_id, state: "running", events: [], next_after_seq: 0, has_more: false } }),
    get_evidence: async () => ({ summary: "not available", data: { available: false } }),
    get_run_result: async (input) => ({ summary: "no result", data: { run_id: input.run_id, verdict: "inconclusive", state: "running", confidence: 0, summary: "", checks: [], key_evidence: [], suggested_next: "", result_available: false } }),
    intervene_run: async (input) => ({ summary: `${input.action} accepted`, data: { run_id: input.run_id, accepted: true, action: input.action } }),
    cancel_run: async (input) => ({ summary: "cancelled", data: { run_id: input.run_id, accepted: true, status: "cancelling" } }),
    get_target_capabilities: async (input) => ({ summary: `${input.target}: ok`, data: { target: input.target, state: "idle", capabilities: [], connections: { serial: "disconnected", adb: "disconnected", fastboot: "disconnected" } } }),
  };
}
