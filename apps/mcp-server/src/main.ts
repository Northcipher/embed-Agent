// MCP Server — @modelcontextprotocol/sdk handles JSON-RPC. Tool schemas from tools.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "@embed-agent/cli";
import {
  ValidateArtifactInput, GetRunStatusInput, WatchRunInput, GetRunEventsInput,
  GetEvidenceInput, GetRunResultInput, InterveneRunInput, CancelRunInput,
  GetTargetCapabilitiesInput,
} from "./tools.js";

const { handler } = await bootstrap();

const server = new McpServer({ name: "embed-agent", version: "1.0.0" });

server.tool("list_targets", "List all configured targets with state, capabilities, connections, and active runs.", {}, async () => {
  const targets = await handler.targetList();
  const result = targets.map(t => {
    const caps: string[] = [];
    if (t.serial === "connected") caps.push("serial_output");
    if (t.adb === "online") caps.push("shell_exec", "wait_adb", "collect_logs", "push");
    if (t.fastboot === "connected") caps.push("flash");
    return { target_id: t.target_id, state: t.state, capabilities: caps, connections: { serial: t.serial, adb: t.adb, fastboot: t.fastboot }, current_run_id: t.current_run_id };
  });
  return { content: [{ type: "text", text: JSON.stringify({ targets: result, summary: `${result.length} target(s)${result.filter(t => t.current_run_id).length ? `. Active: ${result.filter(t => t.current_run_id).map(t => `${t.target_id}(${t.current_run_id})`).join(", ")}` : ""}` }) }] };
});

server.tool("get_target_capabilities", GetTargetCapabilitiesInput.description ?? "Get capabilities for a target", GetTargetCapabilitiesInput.shape, async (input: any) => {
  const r = await handler.getTargetCapabilities(input.target);
  if ("status" in r && r.status === "error") return { content: [{ type: "text", text: JSON.stringify({ target: input.target, state: "unknown", capabilities: [], connections: {} }) }] };
  const t = r as any;
  return { content: [{ type: "text", text: JSON.stringify({ target: t.target, state: t.runtime_state.state, capabilities: t.capabilities, connections: { serial: t.runtime_state.serial, adb: t.runtime_state.adb, fastboot: t.runtime_state.fastboot }, current_run_id: t.runtime_state.current_run_id }) }] };
});

server.tool("validate_artifact", "Start a validation run on a target device.", ValidateArtifactInput.shape, async (input: any) => {
  const ctx: Record<string, unknown> = { task: input.expected, expected: input.expected };
  if (input.concerns) ctx.concerns = input.concerns;
  if (input.success_criteria) ctx.success_criteria = input.success_criteria;
  if (input.failure_criteria) ctx.failure_criteria = input.failure_criteria;
  const mcpInput: Record<string, unknown> = { context: ctx, artifact: { path: input.artifact_path, type: input.artifact_type }, target: input.target };
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
});

server.tool("get_run_status", "Get current state and progress for a run.", GetRunStatusInput.shape, async ({ run_id }: any) => {
  const s = await handler.status(run_id);
  return { content: [{ type: "text", text: JSON.stringify(s ?? { run_id, state: "unknown" }) }] };
});

server.tool("watch_run", "Watch a run for new events (blocks up to wait_sec).", WatchRunInput.shape, async ({ run_id, after_seq = 0, wait_sec = 5 }: any) => {
  const deadline = Date.now() + Math.min(wait_sec, 30) * 1000; let cursor = after_seq;
  while (Date.now() < deadline) { const s = await handler.events(run_id, cursor, 100); if (s.events.length > 0) { const st = await handler.status(run_id); return { content: [{ type: "text", text: JSON.stringify({ run_id, state: st?.state, events: s.events, next_after_seq: s.next_after_seq }) }] }; } await new Promise(r => setTimeout(r, 1000)); }
  const st = await handler.status(run_id); return { content: [{ type: "text", text: JSON.stringify({ run_id, state: st?.state, events: [], next_after_seq: cursor }) }] };
});

server.tool("get_run_events", "Get paginated events for a run.", GetRunEventsInput.shape, async ({ run_id, after_seq = 0, limit = 100, types }: any) => {
  const s = await handler.events(run_id, after_seq, limit, types); const st = await handler.status(run_id);
  return { content: [{ type: "text", text: JSON.stringify({ run_id, state: st?.state, events: s.events, next_after_seq: s.next_after_seq, has_more: s.has_more }) }] };
});

server.tool("get_evidence", "Get evidence index or content for a ref.", GetEvidenceInput.shape, async ({ run_id, ref }: any) => {
  const r = await handler.evidence(run_id, ref);
  if (ref) { const c = (r as any).content ?? ""; return { content: [{ type: "text", text: JSON.stringify({ available: r.available, ref, content: c.length > 50000 ? c.slice(0, 50000) : c, truncated: c.length > 50000 }) }] }; }
  return { content: [{ type: "text", text: JSON.stringify({ available: r.available, index: (r as any).index }) }] };
});

server.tool("get_run_result", "Get final evaluation result with verdict and checks.", GetRunResultInput.shape, async ({ run_id }: any) => {
  const r = await handler.result(run_id); const state = r.state ?? "unknown";
  const verdict = state === "completed" ? "pass" : state === "failed" ? "fail" : state === "cancelled" ? "cancelled" : "inconclusive";
  return { content: [{ type: "text", text: JSON.stringify({ run_id, verdict, state, confidence: verdict === "pass" ? 0.9 : 0.5, summary: r.summary ?? "", suggested_next: r.suggested_next ?? "check evidence", result_available: r.result_available, checks: (r.criteria_results as any[])?.length ? (r.criteria_results as any[]).map((cr: any, i: number) => ({ id: `check-${i}`, title: cr.criterion, status: cr.status, evidence_refs: cr.evidence_refs })) : (r.key_evidence ?? []).map((ke: any, i: number) => ({ id: `check-${i}`, title: ke.summary, status: verdict === "pass" ? "pass" : "fail", evidence_refs: ke.evidence_refs })), key_evidence: r.key_evidence ?? [] }) }] };
});

server.tool("intervene_run", "Intervene in a running validation.", InterveneRunInput.shape, async (input: any) => {
  let result: any;
  if (input.action === "pause") result = await (handler as any).pause(input.run_id, input.reason);
  else if (input.action === "resume") result = await (handler as any).resume(input.run_id);
  else if (input.action === "cancel") result = await (handler as any).cancel(input.run_id, input.reason);
  else if (input.action === "add_instruction") result = await (handler as any).addInstruction(input.run_id, input.instruction ?? input.reason);
  else if (input.action === "ignore_rule") result = await (handler as any).ignoreRule(input.run_id, input.rule_id ?? "");
  else if (input.action === "override") result = await (handler as any).override(input.run_id, input.decision ?? "continue", input.reason);
  else result = { accepted: false, run_id: input.run_id, action: input.action, reason: "Unknown action" };
  return { content: [{ type: "text", text: JSON.stringify("status" in result ? { accepted: false, run_id: input.run_id, action: input.action, reason: result.message } : result) }] };
});

server.tool("cancel_run", "Cancel a running validation.", CancelRunInput.shape, async ({ run_id, reason = "MCP agent" }: any) => {
  const r = await (handler as any).cancel(run_id, reason);
  return { content: [{ type: "text", text: JSON.stringify({ run_id, accepted: "status" in r ? false : r.accepted, status: "cancelling" }) }] };
});

await server.connect(new StdioServerTransport());
