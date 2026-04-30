// MCP Server — thin entry point. All functionality lives in the CLI bootstrap.
import { bootstrap } from "@embed-agent/cli";
import { createMcpServer, type McpTransport } from "./server.js";

const { handler } = await bootstrap();

const handlers = {
  validate_artifact: async (input: Record<string, unknown>) => {
    const context = (input.context ?? {}) as Record<string, unknown>;
    const mcpCtx: { task: string; expected: string; concerns?: string[]; what_changed?: string; test_hint?: { kind: string; command: string; timeout_sec?: number; expected_exit_code?: number } } = {
      task: (context.task as string) ?? "",
      expected: (context.expected as string) ?? "",
    };
    if (context.concerns) mcpCtx.concerns = context.concerns as string[];
    if (context.what_changed) mcpCtx.what_changed = context.what_changed as string;
    if (context.test_hint) mcpCtx.test_hint = context.test_hint as { kind: string; command: string; timeout_sec?: number; expected_exit_code?: number };

    const mcpInput = {
      context: mcpCtx,
      artifact: (input.artifact ?? {}) as { path: string; type: string },
      target: (input.target as string) ?? "",
    } as Parameters<typeof handler.validateFromMcp>[0];
    if (input.constraints) (mcpInput as Record<string, unknown>).constraints = input.constraints;
    return handler.validateFromMcp(mcpInput);
  },

  get_run_status: async (input: Record<string, unknown>) => {
    return handler.status((input.run_id as string) ?? "");
  },

  watch_run: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const s = await handler.events(runId, (input.after_seq as number) ?? 0, (input.limit as number) ?? 100);
    const status = await handler.status(runId);
    return { run_id: runId, status: status?.state ?? "unknown", events: s.events, next_after_seq: s.next_after_seq };
  },

  get_run_events: async (input: Record<string, unknown>) => {
    return handler.events((input.run_id as string) ?? "", (input.after_seq as number) ?? 0, (input.limit as number) ?? 100, input.types as string[] | undefined);
  },

  get_evidence: async (input: Record<string, unknown>) => {
    return handler.evidence((input.run_id as string) ?? "", input.ref as string | undefined);
  },

  get_run_result: async (input: Record<string, unknown>) => {
    return handler.result((input.run_id as string) ?? "");
  },

  intervene_run: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const action = (input.action as string) ?? "";
    if (action === "pause") return handler.pause(runId, (input.reason as string) ?? "MCP");
    if (action === "resume") return handler.resume(runId);
    if (action === "cancel") return handler.cancel(runId, (input.reason as string) ?? "MCP");
    if (action === "add_instruction") return handler.addInstruction(runId, (input.instruction as string) ?? "");
    if (action === "ignore_rule") return handler.ignoreRule(runId, (input.rule_id as string) ?? "");
    if (action === "override") return handler.override(runId, ((input.decision as string) ?? "continue") as "continue" | "stop" | "cancel", input.reason as string | undefined);
    return { run_id: runId, accepted: false, action };
  },

  cancel_run: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    return handler.cancel(runId, (input.reason as string) ?? "MCP");
  },

  get_target_capabilities: async (input: Record<string, unknown>) => {
    return handler.getTargetCapabilities((input.target as string) ?? "");
  },
};

const transport: McpTransport = {
  onmessage: () => {},
  async start() {
    process.stdin.setEncoding("utf-8");
    let buf = "";
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.jsonrpc && this.onmessage) this.onmessage(msg);
        } catch { /* skip malformed */ }
      }
    });
  },
  async send(msg: { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } }) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  },
};

createMcpServer(handlers as never, transport);
transport.start();
