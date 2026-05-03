// MCP Server — thin entry point. All functionality in CLI bootstrap.
import { bootstrap } from "@embed-agent/cli";
import { createMcpServer, type McpTransport } from "./server.js";

const { handler } = await bootstrap();

const handlers = {
  list_targets: async () => {
    const targets = await handler.targetList();
    const result = targets.map(t => {
      const caps: string[] = [];
      if (t.serial === "connected") caps.push("serial_output");
      if (t.adb === "online") caps.push("shell_exec", "wait_adb", "collect_logs", "push");
      if (t.fastboot === "connected") caps.push("flash");
      return { target_id: t.target_id, state: t.state, capabilities: caps, connections: { serial: t.serial, adb: t.adb, fastboot: t.fastboot }, current_run_id: t.current_run_id };
    });
    const active = result.filter(t => t.current_run_id).map(t => `${t.target_id}(${t.current_run_id})`).join(", ");
    return { summary: `${result.length} target(s)${active ? `. Active: ${active}` : ""}`, data: { targets: result } };
  },

  get_target_capabilities: async (input: Record<string, unknown>) => {
    const r = await handler.getTargetCapabilities((input.target as string) ?? "");
    if ("status" in r && r.status === "error") {
      return { summary: `Target "${input.target}" not found`, data: { target: input.target as string, state: "unknown", capabilities: [], connections: { serial: "unknown", adb: "unknown", fastboot: "unknown" } } };
    }
    const t = r as { target: string; runtime_state: Record<string, unknown>; capabilities: string[] };
    return { summary: `${t.target}: ${t.runtime_state.state}, serial=${t.runtime_state.serial}, adb=${t.runtime_state.adb}`, data: { target: t.target, state: t.runtime_state.state as string, capabilities: t.capabilities, connections: { serial: t.runtime_state.serial as string, adb: t.runtime_state.adb as string, fastboot: t.runtime_state.fastboot as string }, current_run_id: t.runtime_state.current_run_id as string | undefined } };
  },

  validate_artifact: async (input: Record<string, unknown>) => {
    const ctx: Record<string, unknown> = {
      task: (input.expected as string) ?? "Validate device",
      expected: (input.expected as string) ?? "",
    };
    if (input.concerns) ctx.concerns = input.concerns;
    if (input.success_criteria) ctx.success_criteria = input.success_criteria;
    if (input.failure_criteria) ctx.failure_criteria = input.failure_criteria;

    // Structured test_hint: { kind?, command?, pattern? }
    const hint = input.test_hint as Record<string, unknown> | undefined;
    if (hint && (hint.command || hint.pattern)) {
      ctx.test_hint = {
        kind: (hint.kind as string) ?? "adb_shell",
        ...(hint.command ? { command: hint.command as string } : {}),
        ...(hint.pattern ? { pattern: hint.pattern as string } : {}),
      };
    }

    const mcpInput: Record<string, unknown> = {
      context: ctx as { task: string; expected: string },
      artifact: { path: (input.artifact_path as string) ?? "", type: (input.artifact_type as string) ?? "" },
      target: (input.target as string) ?? "",
    };
    const cstr: Record<string, unknown> = {};
    if (input.max_duration_sec != null) cstr.max_duration_sec = input.max_duration_sec;
    if (input.allow_flash != null) cstr.allow_flash = input.allow_flash;
    if (input.allow_shell_exec != null) cstr.allow_shell_exec = input.allow_shell_exec;
    if (input.no_flash != null) cstr.no_flash = input.no_flash;
    if (input.continuous != null) cstr.continuous = input.continuous;
    if (Object.keys(cstr).length > 0) mcpInput.constraints = cstr;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (handler as any).validateFromMcp(mcpInput);
    const summary = result.status === "accepted" ? `Run ${result.run_id} started on ${input.target}` : `${result.status}: ${result.reasons?.join(", ") ?? "see details"}`;
    return { summary, data: result };
  },

  get_run_status: async (input: Record<string, unknown>) => {
    const s = await handler.status((input.run_id as string) ?? "");
    if (!s) return { summary: `Run "${input.run_id}" not found`, data: { run_id: input.run_id as string, state: "unknown", elapsed_sec: 0, last_event_seq: 0, evidence_path: "" } };
    return { summary: `${s.run_id}: ${s.state}, ${s.elapsed_sec}s elapsed${s.current_step ? `, step: ${s.current_step.id}` : ""}`, data: { run_id: s.run_id, state: s.state, current_step: s.current_step, elapsed_sec: s.elapsed_sec, last_event_seq: s.last_event_seq ?? 0, evidence_path: s.evidence_path ?? "" } };
  },

  watch_run: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const waitSec = Math.min((input.wait_sec as number) ?? 5, 30);
    const deadline = Date.now() + waitSec * 1000;
    let cursor = (input.after_seq as number) ?? 0;

    const limit = (input.limit as number) ?? 100;
    while (Date.now() < deadline) {
      const s = await handler.events(runId, cursor, limit);
      if (s.events.length > 0) {
        const status = await handler.status(runId);
        return { summary: `${s.events.length} new events. Run is ${status?.state ?? "unknown"}`, data: { run_id: runId, state: status?.state ?? "unknown", events: s.events, next_after_seq: s.next_after_seq } };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    const status = await handler.status(runId);
    return { summary: `No new events within ${waitSec}s. Run is ${status?.state ?? "unknown"}`, data: { run_id: runId, state: status?.state ?? "unknown", events: [], next_after_seq: cursor } };
  },

  get_run_events: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const s = await handler.events(runId, (input.after_seq as number) ?? 0, (input.limit as number) ?? 100, input.types as string[] | undefined);
    const status = await handler.status(runId);
    return { summary: `${s.events.length} event(s), has_more=${s.has_more}. Run is ${status?.state ?? "unknown"}`, data: { run_id: runId, state: status?.state ?? "unknown", events: s.events, next_after_seq: s.next_after_seq, has_more: s.has_more } };
  },

  get_evidence: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const ref = input.ref as string | undefined;
    const r = await handler.evidence(runId, ref);
    if (ref) {
      const fullContent = (r as { content?: string }).content ?? "";
      const truncated = fullContent.length > 50000;
      return { summary: r.available ? `Evidence "${ref}": ${fullContent.length} chars${truncated ? " (truncated)" : ""}` : `Evidence "${ref}" not available`, data: { available: r.available, ref, content: truncated ? fullContent.slice(0, 50000) : fullContent, truncated } };
    }
    const idx = (r as { index?: { refs: unknown[] } }).index;
    return { summary: `Evidence index: ${idx?.refs?.length ?? 0} refs available`, data: { available: r.available, index: idx } };
  },

  get_run_result: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const r = await handler.result(runId);
    const state = r.state ?? "unknown";
    const verdict = state === "completed" ? "pass" as const : state === "failed" ? "fail" as const : state === "cancelled" ? "cancelled" as const : state === "running" ? "inconclusive" as const : "blocked" as const;
    return {
      summary: `${verdict.toUpperCase()}: ${r.summary ?? "no summary"}`,
      data: {
        run_id: runId, verdict, state, confidence: verdict === "pass" ? 0.9 : 0.5,
        summary: r.summary ?? "", suggested_next: r.suggested_next ?? "check evidence", result_available: r.result_available,
        checks: (r.criteria_results as { criterion: string; status: string; evidence_refs: string[] }[] | undefined)?.length
          ? (r.criteria_results as { criterion: string; status: string; evidence_refs: string[] }[]).map((cr, i) => ({ id: `check-${i}`, title: cr.criterion, status: cr.status as "pass" | "fail" | "unknown", reason: cr.status === "pass" ? "Criterion met" : cr.status === "fail" ? "Criterion not met" : "Insufficient evidence", evidence_refs: cr.evidence_refs }))
          : (r.key_evidence ?? []).map((ke: { summary: string; evidence_refs: string[] }, i: number) => ({ id: `check-${i}`, title: ke.summary, status: verdict === "pass" ? "pass" as const : "fail" as const, reason: ke.summary, evidence_refs: ke.evidence_refs })),
        key_evidence: r.key_evidence ?? [],
      },
    };
  },

  intervene_run: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const action = (input.action as string) ?? "";
    const reason = (input.reason as string) ?? "MCP agent intervention";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: { accepted: boolean; run_id: string; action: string; reason?: string };
    if (action === "pause") { const r = await (handler as any).pause(runId, reason); result = "status" in r ? { accepted: false, run_id: runId, action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: runId, action }; }
    else if (action === "resume") { const r = await (handler as any).resume(runId); result = "status" in r ? { accepted: false, run_id: runId, action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: runId, action }; }
    else if (action === "cancel") { const r = await (handler as any).cancel(runId, reason); result = "status" in r ? { accepted: false, run_id: runId, action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: runId, action }; }
    else if (action === "add_instruction") { const r = await (handler as any).addInstruction(runId, (input.instruction as string) ?? ""); result = "status" in r ? { accepted: false, run_id: runId, action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: runId, action }; }
    else if (action === "ignore_rule") { const r = await (handler as any).ignoreRule(runId, (input.rule_id as string) ?? ""); result = "status" in r ? { accepted: false, run_id: runId, action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: runId, action }; }
    else if (action === "override") { const r = await (handler as any).override(runId, ((input.decision as string) ?? "continue") as "continue" | "stop" | "cancel", reason); result = "status" in r ? { accepted: false, run_id: runId, action, reason: r.message ?? "failed" } : { accepted: r.accepted, run_id: runId, action }; }
    else { result = { accepted: false, run_id: runId, action, reason: "Unknown action" }; }
    return { summary: result.accepted ? `${action} accepted for ${runId}` : `${action} rejected for ${runId}: ${result.reason}`, data: result };
  },

  cancel_run: async (input: Record<string, unknown>) => {
    const runId = (input.run_id as string) ?? "";
    const reason = (input.reason as string) ?? "MCP agent";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (handler as any).cancel(runId, reason);
    const accepted = "status" in r ? false : r.accepted;
    return { summary: accepted ? `Run ${runId} cancelled` : `Failed to cancel ${runId}`, data: { run_id: runId, accepted, status: accepted ? "cancelling" : "error" } };
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
