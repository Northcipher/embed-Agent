// MCP Server — uses @modelcontextprotocol/sdk for JSON-RPC protocol.
// Tool handlers + Zod schemas are our own. SDK handles transport + negotiation.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "@embed-agent/cli";
import { z } from "zod/v4";

const { handler } = await bootstrap();

const server = new McpServer({
  name: "embed-agent",
  version: "1.0.0",
});

// ── Tool definitions ──────────────────────────────────────

server.tool(
  "list_targets",
  "List all configured targets with state, capabilities, connections, and active runs. Start here to discover available devices.",
  {},
  async () => {
    const targets = await handler.targetList();
    const result = targets.map(t => {
      const caps: string[] = [];
      if (t.serial === "connected") caps.push("serial_output");
      if (t.adb === "online") caps.push("shell_exec", "wait_adb", "collect_logs", "push");
      if (t.fastboot === "connected") caps.push("flash");
      return { target_id: t.target_id, state: t.state, capabilities: caps, connections: { serial: t.serial, adb: t.adb, fastboot: t.fastboot }, current_run_id: t.current_run_id };
    });
    const active = result.filter(t => t.current_run_id).map(t => `${t.target_id}(${t.current_run_id})`).join(", ");
    return { content: [{ type: "text", text: JSON.stringify({ targets: result, summary: `${result.length} target(s)${active ? `. Active: ${active}` : ""}` }) }] };
  },
);

server.tool(
  "get_target_capabilities",
  "Get the capabilities, connection state, and runtime info for a specific target device.",
  { target: z.string().describe("Target device ID") },
  async ({ target }) => {
    const r = await handler.getTargetCapabilities(target);
    if ("status" in r && r.status === "error") {
      return { content: [{ type: "text", text: JSON.stringify({ target, state: "unknown", capabilities: [], connections: {} }) }] };
    }
    const t = r as { target: string; runtime_state: Record<string, unknown>; capabilities: string[] };
    return { content: [{ type: "text", text: JSON.stringify({ target: t.target, state: t.runtime_state.state, capabilities: t.capabilities, connections: { serial: t.runtime_state.serial, adb: t.runtime_state.adb, fastboot: t.runtime_state.fastboot }, current_run_id: t.runtime_state.current_run_id }) }] };
  },
);

server.tool(
  "validate_artifact",
  "Start a validation run on a target device. Required: target, artifact_path, artifact_type, expected.",
  {
    target: z.string().describe("Target device ID"),
    artifact_path: z.string().describe("Path to firmware/artifact file"),
    artifact_type: z.string().describe("Type: firmware, apk, binary, config, other"),
    expected: z.string().describe("What should happen, e.g. 'Device boots to login prompt'"),
    concerns: z.array(z.string()).optional(),
    success_criteria: z.array(z.string()).optional(),
    failure_criteria: z.array(z.string()).optional(),
    max_duration_sec: z.number().optional(),
    allow_flash: z.boolean().optional(),
    allow_shell_exec: z.boolean().optional(),
    no_flash: z.boolean().optional(),
    continuous: z.boolean().optional(),
  },
  async (input) => {
    const mcpInput: Record<string, unknown> = {
      context: { task: input.expected, expected: input.expected },
      artifact: { path: input.artifact_path, type: input.artifact_type },
      target: input.target,
    };
    if (input.concerns) (mcpInput.context as any).concerns = input.concerns;
    if (input.success_criteria) (mcpInput.context as any).success_criteria = input.success_criteria;
    if (input.failure_criteria) (mcpInput.context as any).failure_criteria = input.failure_criteria;
    const cstr: Record<string, unknown> = {};
    if (input.max_duration_sec != null) cstr.max_duration_sec = input.max_duration_sec;
    if (input.allow_flash != null) cstr.allow_flash = input.allow_flash;
    if (input.allow_shell_exec != null) cstr.allow_shell_exec = input.allow_shell_exec;
    if (input.no_flash != null) cstr.no_flash = input.no_flash;
    if (input.continuous != null) cstr.continuous = input.continuous;
    if (Object.keys(cstr).length > 0) mcpInput.constraints = cstr;

    const result: any = await (handler as any).validateFromMcp(mcpInput);
    const summary = result.status === "accepted" ? `Run ${result.run_id} started on ${input.target}` : `${result.status}: ${result.reasons?.join(", ") ?? "see details"}`;
    return { content: [{ type: "text", text: JSON.stringify({ summary, data: result }) }] };
  },
);

server.tool(
  "get_run_status",
  "Get the current state, progress, and recent decisions for a validation run.",
  { run_id: z.string().describe("Run ID") },
  async ({ run_id }) => {
    const s = await handler.status(run_id);
    if (!s) return { content: [{ type: "text", text: JSON.stringify({ run_id, state: "unknown" }) }] };
    return { content: [{ type: "text", text: JSON.stringify({ run_id: s.run_id, state: s.state, current_step: s.current_step, elapsed_sec: s.elapsed_sec, last_event_seq: s.last_event_seq ?? 0, evidence_path: s.evidence_path ?? "" }) }] };
  },
);

server.tool(
  "watch_run",
  "Watch a run for new events. Blocks up to wait_sec (max 30s) until new events arrive.",
  { run_id: z.string().describe("Run ID"), after_seq: z.number().optional(), wait_sec: z.number().optional() },
  async ({ run_id, after_seq = 0, wait_sec = 5 }) => {
    const deadline = Date.now() + Math.min(wait_sec, 30) * 1000;
    let cursor = after_seq;
    while (Date.now() < deadline) {
      const s = await handler.events(run_id, cursor, 100);
      if (s.events.length > 0) {
        const status = await handler.status(run_id);
        return { content: [{ type: "text", text: JSON.stringify({ run_id, state: status?.state ?? "unknown", events: s.events, next_after_seq: s.next_after_seq }) }] };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    const status = await handler.status(run_id);
    return { content: [{ type: "text", text: JSON.stringify({ run_id, state: status?.state ?? "unknown", events: [], next_after_seq: cursor }) }] };
  },
);

server.tool(
  "get_run_events",
  "Get paginated events for a run with optional type filtering.",
  { run_id: z.string().describe("Run ID"), after_seq: z.number().optional(), limit: z.number().optional(), types: z.array(z.string()).optional() },
  async ({ run_id, after_seq = 0, limit = 100, types }) => {
    const s = await handler.events(run_id, after_seq, limit, types);
    const status = await handler.status(run_id);
    return { content: [{ type: "text", text: JSON.stringify({ run_id, state: status?.state ?? "unknown", events: s.events, next_after_seq: s.next_after_seq, has_more: s.has_more }) }] };
  },
);

server.tool(
  "get_evidence",
  "Get evidence from a run. Without ref, returns the evidence index. With ref, returns content.",
  { run_id: z.string().describe("Run ID"), ref: z.string().optional().describe("Evidence ref, e.g. 'serial:last-window'") },
  async ({ run_id, ref }) => {
    const r = await handler.evidence(run_id, ref);
    if (ref) {
      const fullContent = (r as { content?: string }).content ?? "";
      const truncated = fullContent.length > 50000;
      return { content: [{ type: "text", text: JSON.stringify({ available: r.available, ref, content: truncated ? fullContent.slice(0, 50000) : fullContent, truncated }) }] };
    }
    const idx = (r as { index?: { refs: unknown[] } }).index;
    return { content: [{ type: "text", text: JSON.stringify({ available: r.available, index: idx }) }] };
  },
);

server.tool(
  "get_run_result",
  "Get the final evaluation result for a completed run with verdict, criteria checks, and key evidence.",
  { run_id: z.string().describe("Run ID") },
  async ({ run_id }) => {
    const r = await handler.result(run_id);
    const state = r.state ?? "unknown";
    const verdict = state === "completed" ? "pass" as const : state === "failed" ? "fail" as const : state === "cancelled" ? "cancelled" as const : state === "running" ? "inconclusive" as const : "blocked" as const;
    return { content: [{ type: "text", text: JSON.stringify({
      run_id, verdict, state, confidence: verdict === "pass" ? 0.9 : 0.5,
      summary: r.summary ?? "", suggested_next: r.suggested_next ?? "check evidence", result_available: r.result_available,
      checks: (r.criteria_results as any[])?.length
        ? (r.criteria_results as any[]).map((cr, i) => ({ id: `check-${i}`, title: cr.criterion, status: cr.status, reason: cr.status === "pass" ? "Criterion met" : cr.status === "fail" ? "Criterion not met" : "Insufficient evidence", evidence_refs: cr.evidence_refs }))
        : (r.key_evidence ?? []).map((ke: any, i: number) => ({ id: `check-${i}`, title: ke.summary, status: verdict === "pass" ? "pass" : "fail", reason: ke.summary, evidence_refs: ke.evidence_refs })),
      key_evidence: r.key_evidence ?? [],
    }) }] };
  },
);

server.tool(
  "intervene_run",
  "Intervene in a running validation — pause, resume, cancel, add instruction, ignore rule, or override decision.",
  {
    run_id: z.string().describe("Run ID"),
    action: z.enum(["pause", "resume", "cancel", "add_instruction", "ignore_rule", "override"]).describe("Intervention action"),
    reason: z.string().describe("Why this intervention is needed"),
    instruction: z.string().optional().describe("Instruction text for add_instruction"),
    rule_id: z.string().optional().describe("Rule ID for ignore_rule"),
    decision: z.enum(["continue", "stop", "cancel"]).optional().describe("Decision for override"),
  },
  async (input) => {
    let result: { accepted: boolean; run_id: string; action: string; reason?: string };
    const reason = input.reason;
    if (input.action === "pause") { const r = await (handler as any).pause(input.run_id, reason); result = "status" in r ? { accepted: false, run_id: input.run_id, action: input.action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: input.run_id, action: input.action }; }
    else if (input.action === "resume") { const r = await (handler as any).resume(input.run_id); result = "status" in r ? { accepted: false, run_id: input.run_id, action: input.action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: input.run_id, action: input.action }; }
    else if (input.action === "cancel") { const r = await (handler as any).cancel(input.run_id, reason); result = "status" in r ? { accepted: false, run_id: input.run_id, action: input.action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: input.run_id, action: input.action }; }
    else if (input.action === "add_instruction") { const r = await (handler as any).addInstruction(input.run_id, input.instruction ?? reason); result = "status" in r ? { accepted: false, run_id: input.run_id, action: input.action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: input.run_id, action: input.action }; }
    else if (input.action === "ignore_rule") { const r = await (handler as any).ignoreRule(input.run_id, input.rule_id ?? ""); result = "status" in r ? { accepted: false, run_id: input.run_id, action: input.action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: input.run_id, action: input.action }; }
    else if (input.action === "override") { const r = await (handler as any).override(input.run_id, (input.decision ?? "continue") as "continue" | "stop" | "cancel", reason); result = "status" in r ? { accepted: false, run_id: input.run_id, action: input.action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: input.run_id, action: input.action }; }
    else { result = { accepted: false, run_id: input.run_id, action: input.action, reason: "Unknown action" }; }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "cancel_run",
  "Cancel a running validation.",
  { run_id: z.string().describe("Run ID"), reason: z.string().optional().describe("Reason for cancellation") },
  async ({ run_id, reason = "MCP agent" }) => {
    const r = await (handler as any).cancel(run_id, reason);
    const accepted = "status" in r ? false : r.accepted;
    return { content: [{ type: "text", text: JSON.stringify({ run_id, accepted, status: accepted ? "cancelling" : "error" }) }] };
  },
);

// ── Transport ──────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
