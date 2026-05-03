/**
 * MCP Server v2 smoke test — validates JSON-RPC protocol and tool definitions.
 * Tests MCP server directly (no subprocess) using the same pattern as server.test.ts.
 */
import { describe, it, expect } from "vitest";
import { createMcpServer, type McpMessage } from "../src/server.js";
import { TOOL_DEFINITIONS, type ToolHandlers } from "../src/tools.js";

function createFakeTransport() {
  const sent: McpMessage[] = [];
  return {
    transport: {
      onmessage: null as ((msg: McpMessage) => void) | null,
      send(msg: McpMessage) { sent.push(msg); },
      start() {},
      // simulate receiving a message
      simulate(msg: McpMessage) { return Promise.resolve(this.onmessage?.(msg)); },
    },
    sent,
  };
}

function createHandlers(overrides: Partial<ToolHandlers> = {}): ToolHandlers {
  return {
    list_targets: async () => ({
      summary: "3 targets. Active: dev1(run-1)", data: { targets: [{ target_id: "e2e-device", state: "idle", capabilities: ["shell_exec"], connections: { serial: "connected", adb: "online", fastboot: "disconnected" }, current_run_id: undefined }] },
    }),
    get_target_capabilities: async (input) => ({
      summary: `${input.target}: idle`, data: { target: input.target as string, state: "idle", capabilities: ["shell_exec"], connections: { serial: "connected", adb: "online", fastboot: "disconnected" }, current_run_id: undefined },
    }),
    validate_artifact: async () => ({
      summary: "Run run-test-1 started on e2e-device", data: { status: "accepted", run_id: "run-test-1", state: "running", evidence_path: ".embed-agent/runs/run-test-1" },
    }),
    get_run_status: async (input) => ({
      summary: `run-test-1: completed, 15s elapsed`, data: { run_id: input.run_id as string, state: "completed", current_step: undefined, elapsed_sec: 15, last_event_seq: 0, evidence_path: "" },
    }),
    watch_run: async (input) => ({
      summary: "3 new events. Run is completed", data: { run_id: input.run_id as string, state: "completed", events: [], next_after_seq: 3 },
    }),
    get_run_events: async (input) => ({
      summary: "13 event(s), has_more=false. Run is completed", data: { run_id: input.run_id as string, state: "completed", events: [], next_after_seq: 13, has_more: false },
    }),
    get_evidence: async (input) => {
      if (input.ref) return { summary: "Evidence read", data: { available: true, ref: input.ref as string, content: "serial output content" } };
      return { summary: "Evidence index: 2 refs", data: { available: true, index: { refs: [{ ref: "serial:full", kind: "serial", bytes: 1024, available: true }] } } };
    },
    get_run_result: async (input) => ({
      summary: "PASS: All criteria met", data: {
        run_id: input.run_id as string, verdict: "pass", state: "completed", confidence: 0.95,
        summary: "Device responded to shell and dmesg showed kernel output.",
        suggested_next: "deploy to staging", result_available: true,
        checks: [{ id: "check-0", title: "shell responds", status: "pass", reason: "Criterion met", evidence_refs: ["serial:full"] }],
        key_evidence: [{ summary: "Shell check passed", evidence_refs: ["serial:full"] }],
      },
    }),
    intervene_run: async (input) => ({
      summary: "pause accepted for run-test-1", data: { accepted: true, run_id: input.run_id as string, action: "pause" },
    }),
    cancel_run: async (input) => ({
      summary: "Run run-test-1 cancelled", data: { run_id: input.run_id as string, accepted: true, status: "cancelling" },
    }),
    ...overrides,
  };
}

describe("MCP Server v2 Protocol", () => {
  it("has 10 tool definitions with correct names", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(10);
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toEqual([
      "list_targets", "get_target_capabilities", "validate_artifact",
      "get_run_status", "watch_run", "get_run_events",
      "get_evidence", "get_run_result", "intervene_run", "cancel_run",
    ]);
  });

  it("validate_artifact returns run_id in data", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport as any);

    await (transport as any).simulate({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "validate_artifact", arguments: { target: "e2e-device", artifact_path: "/tmp/test.bin", artifact_type: "firmware", expected: "Boot" } },
    });

    const text = (sent[0]?.result as any)?.content?.[0]?.text ?? "";
    const parts = text.split("\n\n");
    const summary = parts[0] ?? "";
    const data = JSON.parse(parts[1] ?? "{}");
    expect(summary).toContain("started");
    expect(data.run_id).toBe("run-test-1");
    expect(data.status).toBe("accepted");
  });

  it("get_run_result returns criteria_results format", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport as any);

    await (transport as any).simulate({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_run_result", arguments: { run_id: "run-test-1" } },
    });

    const text = (sent[0]?.result as any)?.content?.[0]?.text ?? "";
    const parts = text.split("\n\n");
    const data = JSON.parse(parts[1] ?? "{}");
    expect(data.verdict).toBe("pass");
    expect(data.checks.length).toBe(1);
    expect(data.checks[0].status).toBe("pass");
    expect(data.key_evidence.length).toBe(1);
  });

  it("intervene_run supports all v2 actions", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport as any);

    const actions = ["pause", "resume", "cancel", "add_instruction", "ignore_rule", "override"];
    for (const action of actions) {
      sent.length = 0;
      await (transport as any).simulate({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "intervene_run", arguments: { run_id: "run-1", action, reason: "test" } },
      });
      const text = (sent[0]?.result as any)?.content?.[0]?.text ?? "";
      const parts = text.split("\n\n");
      const summary = parts[0] ?? "";
      const data = JSON.parse(parts[1] ?? "{}");
      expect(data.accepted).toBe(true);
      expect(summary).toContain("accepted");
    }
  });

  it("initialize negotiates protocol version", async () => {
    const { transport, sent } = createFakeTransport();
    createMcpServer(createHandlers(), transport as any);

    await (transport as any).simulate({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0", id: 1,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "embed-agent", version: "1.0.0" } },
    });
  });
});
