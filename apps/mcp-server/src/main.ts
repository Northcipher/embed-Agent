// MCP Server — thin adapter. Forwards all tool calls to the HTTP Runtime.
// Uses @modelcontextprotocol/sdk for JSON-RPC protocol.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpCommandHandler } from "@embed-agent/cli/http-client.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ValidateArtifactInput, GetRunStatusInput, WatchRunInput, GetRunEventsInput,
  GetEvidenceInput, GetRunResultInput, InterveneRunInput, CancelRunInput,
  GetTargetCapabilitiesInput,
} from "./tools.js";

const DEFAULT_URL = process.env["EMBED_AGENT_SERVER_URL"] ?? "http://127.0.0.1:8787";

async function isServerRunning(url: string): Promise<boolean> {
  try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

async function ensureServer(url: string): Promise<void> {
  if (await isServerRunning(url)) return;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const serverEntry = path.resolve(cliDir, "../../http-server/dist/main.js");
  const port = String(new URL(url).port || 8787);
  const proc = spawn("node", [serverEntry], { stdio: "ignore", detached: true, env: { ...process.env, PORT: port } });
  proc.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await isServerRunning(url)) return; await new Promise(r => setTimeout(r, 500)); }
  try { proc.kill(); } catch {}
  throw new Error(`Runtime server failed to start at ${url}`);
}

await ensureServer(DEFAULT_URL);
const handler = new HttpCommandHandler(DEFAULT_URL);

const server = new McpServer({ name: "embed-agent", version: "1.0.0" });

server.tool("list_targets", "List all configured targets with state, capabilities, and active runs.", {}, async () => {
  const targets = await handler.targetList();
  const result = targets.map((t: any) => {
    const caps: string[] = [];
    if (t.serial === "connected") caps.push("serial_output");
    if (t.adb === "online") caps.push("shell_exec", "wait_adb", "collect_logs", "push");
    if (t.fastboot === "connected") caps.push("flash");
    return { target_id: t.target_id, state: t.state, capabilities: caps, connections: { serial: t.serial, adb: t.adb, fastboot: t.fastboot }, current_run_id: t.current_run_id };
  });
  const activeTargets = result.filter((t: any) => t.current_run_id).map((t: any) => t.target_id).join(",");
  return { content: [{ type: "text", text: JSON.stringify({ targets: result, summary: `${result.length} target(s)${activeTargets ? ` active: ${activeTargets}` : ""}` }) }] };
});

server.tool("get_target_capabilities", "Get capabilities and state for a target.", GetTargetCapabilitiesInput.shape, async (input: any) => {
  const r = await handler.getTargetCapabilities(input.target);
  if ("status" in r && r.status === "error") return { content: [{ type: "text", text: JSON.stringify({ target: input.target, state: "unknown", capabilities: [], connections: {} }) }] };
  const t = r as any;
  return { content: [{ type: "text", text: JSON.stringify({ target: t.target, state: t.runtime_state.state, capabilities: t.capabilities, connections: { serial: t.runtime_state.serial, adb: t.runtime_state.adb, fastboot: t.runtime_state.fastboot }, current_run_id: t.runtime_state.current_run_id }) }] };
});

server.tool("validate_artifact", "Start a validation run on a target device.", ValidateArtifactInput.shape, async (input: any) => {
  const result: any = await handler.validate({
    artifact: { path: input.artifact_path, type: input.artifact_type },
    target: input.target,
    expected: input.expected,
    concerns: input.concerns,
    success_criteria: input.success_criteria,
    failure_criteria: input.failure_criteria,
    constraints: {
      max_duration_sec: input.max_duration_sec,
      allow_flash: input.allow_flash,
      allow_shell_exec: input.allow_shell_exec,
      no_flash: input.no_flash,
      continuous: input.continuous,
    },
  } as any);
  const summary = result.status === "accepted" ? `Run ${result.run_id} started on ${input.target}` : `${result.status}: ${result.reasons?.join(", ") ?? "see details"}`;
  return { content: [{ type: "text", text: JSON.stringify({ summary, data: result }) }] };
});

server.tool("get_run_status", "Get current state and progress for a run.", GetRunStatusInput.shape, async ({ run_id }: any) => {
  const s = await handler.status(run_id);
  return { content: [{ type: "text", text: JSON.stringify(s ?? { run_id, state: "unknown" }) }] };
});

server.tool("watch_run", "Watch a run for new events.", WatchRunInput.shape, async ({ run_id, after_seq = 0, wait_sec = 5 }: any) => {
  const deadline = Date.now() + Math.min(wait_sec, 30) * 1000; let cursor = after_seq;
  while (Date.now() < deadline) { const s = await handler.events(run_id, cursor, 100); if (s.events.length > 0) { const st = await handler.status(run_id); return { content: [{ type: "text", text: JSON.stringify({ run_id, state: st?.state, events: s.events, next_after_seq: s.next_after_seq }) }] }; } await new Promise(r => setTimeout(r, 1000)); }
  const st = await handler.status(run_id); return { content: [{ type: "text", text: JSON.stringify({ run_id, state: st?.state, events: [], next_after_seq: cursor }) }] };
});

server.tool("get_run_events", "Get paginated events for a run.", GetRunEventsInput.shape, async ({ run_id, after_seq = 0, limit = 100, types }: any) => {
  const s = await handler.events(run_id, after_seq, limit, types); const st = await handler.status(run_id);
  return { content: [{ type: "text", text: JSON.stringify({ run_id, state: st?.state, events: s.events, next_after_seq: s.next_after_seq, has_more: s.has_more }) }] };
});

server.tool("get_evidence", "Get evidence index or content.", GetEvidenceInput.shape, async ({ run_id, ref }: any) => {
  const r = await handler.evidence(run_id, ref);
  if (ref) { const c = (r as any).content ?? ""; return { content: [{ type: "text", text: JSON.stringify({ available: r.available, ref, content: c.length > 50000 ? c.slice(0, 50000) : c, truncated: c.length > 50000 }) }] }; }
  return { content: [{ type: "text", text: JSON.stringify({ available: r.available, index: (r as any).index }) }] };
});

server.tool("get_run_result", "Get final evaluation result.", GetRunResultInput.shape, async ({ run_id }: any) => {
  const r = await handler.result(run_id); const state = r.state ?? "unknown";
  const verdict = state === "completed" ? "pass" : state === "failed" ? "fail" : state === "cancelled" ? "cancelled" : "inconclusive";
  return { content: [{ type: "text", text: JSON.stringify({ run_id, verdict, state, confidence: verdict === "pass" ? 0.9 : 0.5, summary: r.summary ?? "", suggested_next: r.suggested_next ?? "check evidence", result_available: r.result_available, checks: (r.criteria_results as any[])?.length ? (r.criteria_results as any[]).map((cr: any, i: number) => ({ id: `check-${i}`, title: cr.criterion, status: cr.status, evidence_refs: cr.evidence_refs })) : (r.key_evidence ?? []).map((ke: any, i: number) => ({ id: `check-${i}`, title: ke.summary, status: verdict === "pass" ? "pass" : "fail", evidence_refs: ke.evidence_refs })), key_evidence: r.key_evidence ?? [] }) }] };
});

server.tool("intervene_run", "Intervene in a running validation.", InterveneRunInput.shape, async (input: any) => {
  let result: any;
  if (input.action === "pause") result = await handler.pause(input.run_id, input.reason);
  else if (input.action === "resume") result = await handler.resume(input.run_id);
  else if (input.action === "cancel") result = await handler.cancel(input.run_id, input.reason);
  else if (input.action === "add_instruction") result = await handler.addInstruction(input.run_id, input.instruction ?? input.reason);
  else if (input.action === "ignore_rule") result = await handler.ignoreRule(input.run_id, input.rule_id ?? "");
  else if (input.action === "override") result = await handler.override(input.run_id, input.decision ?? "continue", input.reason);
  else result = { accepted: false, run_id: input.run_id, action: input.action, reason: "Unknown action" };
  return { content: [{ type: "text", text: JSON.stringify("status" in (result || {}) ? { accepted: false, run_id: input.run_id, action: input.action, reason: (result as any)?.message } : result) }] };
});

server.tool("cancel_run", "Cancel a running validation.", CancelRunInput.shape, async ({ run_id, reason = "MCP agent" }: any) => {
  const r: any = await handler.cancel(run_id, reason);
  return { content: [{ type: "text", text: JSON.stringify({ run_id, accepted: r?.accepted ?? false, status: "cancelling" }) }] };
});

await server.connect(new StdioServerTransport());
