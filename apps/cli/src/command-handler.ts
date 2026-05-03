import type { ValidateRequest } from "@embed-agent/runtime";

interface EventEmitterLike {
  emit(e: Record<string, unknown>): Promise<void>;
}

interface RunManagerLike {
  createRun(req: ValidateRequest): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }>;
  pause(runId: string, reason: string): Promise<void>;
  onOverride?(runId: string): void;
  resume(runId: string): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
  stopRun?(runId: string, reason: string): Promise<void>;
}

interface MemoryStoreLike {
  writeFact(fact: { scope: string; scope_id: string; category: string; statement: string; fact_id: string; source: string; evidence_refs: string[]; verified: boolean; created_at: string }): Promise<void>;
  updateFact(factId: string, patch: Record<string, unknown>): Promise<void>;
  deleteFact(factId: string): Promise<void>;
}
interface SkillStoreLike {
  list(): { name: string; description: string }[];
  get(name: string): { name: string; description: string; steps: { action: string; capability: string; command?: string; timeout_sec: number }[] } | undefined;
}

interface ViewsLike {
  status(runId: string): Promise<{ run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; last_event_seq: number; evidence_path: string } | null>;
  events(runId: string, afterSeq?: number, limit?: number, types?: string[]): Promise<{ events: { seq: number; type: string; severity?: string; summary: string; time: string; step_id?: string; payload?: Record<string, unknown>; evidence_refs?: string[] }[]; next_after_seq: number; has_more: boolean }>;
  result(runId: string): Promise<{ run_id: string; state: string; result_available: boolean; summary?: string; suggested_next?: string; evidence_path?: string; key_evidence?: { summary: string; evidence_refs: string[] }[]; criteria_results?: { criterion: string; status: string; evidence_refs: string[] }[] }>;
  evidence(runId: string, ref?: string): Promise<{ available: boolean; index?: { refs: { ref: string; kind: string }[] }; content?: string }>;
  targets(): Promise<{ target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string }[]>;
  history(targetId: string, limit?: number): Promise<{ episode_id: string; result: string; summary: string }[]>;
}

export interface ErrorResult {
  status: "error";
  error_code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class CommandHandler {
  constructor(
    private rm: RunManagerLike,
    private views: ViewsLike,
    private memoryStore?: MemoryStoreLike,
    private skillStore?: SkillStoreLike,
    private eb?: EventEmitterLike,
  ) {}

  // --- Validation & Execution ---

  async validate(req: ValidateRequest): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }> {
    return this.rm.createRun(req);
  }

  /** MCP adapter: converts MCP validate_artifact input to ValidateRequest. */
  async validateFromMcp(mcpInput: {
    context: { task: string; expected: string; concerns?: string[]; what_changed?: string; success_criteria?: string[]; failure_criteria?: string[]; test_hint?: { kind: string; command: string; timeout_sec?: number; expected_exit_code?: number } };
    artifact: { path: string; type: string; version?: string; build_id?: string };
    target: string;
    constraints?: { max_duration_sec?: number; allow_flash?: boolean; no_flash?: boolean; continuous?: boolean };
  }): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[]; missing_info?: string[]; suggested_next?: string }> {
    const req = {
      artifact: mcpInput.artifact,
      target: mcpInput.target,
      expected: mcpInput.context.expected,
    } as ValidateRequest;
    if (mcpInput.context.concerns) req.concerns = mcpInput.context.concerns;
    if (mcpInput.context.success_criteria) req.success_criteria = mcpInput.context.success_criteria;
    if (mcpInput.context.failure_criteria) req.failure_criteria = mcpInput.context.failure_criteria;
    if (mcpInput.context.test_hint) req.test_hint = mcpInput.context.test_hint as NonNullable<typeof mcpInput.context.test_hint>;
    if (mcpInput.constraints) req.constraints = mcpInput.constraints;
    const result = await this.rm.createRun(req);
    if (result.status === "plan_rejected" || result.status === "clarification_needed") {
      const out: { status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[]; missing_info?: string[]; suggested_next?: string } = { status: result.status };
      if (result.run_id) out.run_id = result.run_id;
      if (result.reasons) { out.reasons = result.reasons; out.missing_info = result.reasons; }
      if (result.failed_checks) out.failed_checks = result.failed_checks;
      if (!out.missing_info) out.missing_info = [];
      out.suggested_next = "provide missing information and retry";
      return out;
    }
    return result;
  }

  // --- Query ---

  async status(runId: string) { return this.views.status(runId); }
  async events(runId: string, afterSeq?: number, limit?: number, types?: string[]) { return this.views.events(runId, afterSeq, limit, types); }
  async result(runId: string) { return this.views.result(runId); }
  async evidence(runId: string, ref?: string) { return this.views.evidence(runId, ref); }
  async targetList() { return this.views.targets(); }
  async history(targetId: string, limit?: number) { return this.views.history(targetId, limit); }

  async getTargetCapabilities(targetId: string): Promise<{
    target: string; runtime_state: Record<string, unknown>; capabilities: string[];
  } | ErrorResult> {
    const targets = await this.views.targets();
    const t = targets.find(x => x.target_id === targetId);
    if (!t) return { status: "error", error_code: "target_not_found", message: `Target not found: ${targetId}` };
    // Derive capabilities from connection state
    const capabilities: string[] = [];
    if (t.serial === "connected") capabilities.push("serial_output");
    if (t.adb === "online") capabilities.push("shell_exec", "wait_adb", "collect_logs", "push");
    if (t.fastboot === "connected") capabilities.push("flash");
    return {
      target: targetId,
      runtime_state: { state: t.state, serial: t.serial, adb: t.adb, fastboot: t.fastboot, current_run_id: t.current_run_id },
      capabilities,
    };
  }

  // --- Intervention ---

  async pause(runId: string, reason = "manual"): Promise<{ accepted: boolean; run_id: string } | ErrorResult> {
    try { await this.rm.pause(runId, reason); return { accepted: true, run_id: runId }; }
    catch (e) { return { status: "error", error_code: "run_not_found", message: (e as Error).message, details: { run_id: runId } }; }
  }

  async resume(runId: string): Promise<{ accepted: boolean; run_id: string } | ErrorResult> {
    try { await this.rm.resume(runId); return { accepted: true, run_id: runId }; }
    catch (e) { return { status: "error", error_code: "run_not_found", message: (e as Error).message, details: { run_id: runId } }; }
  }

  async cancel(runId: string, reason = "manual"): Promise<{ accepted: boolean; run_id: string; status: string } | ErrorResult> {
    try { await this.rm.cancel(runId, reason); return { accepted: true, run_id: runId, status: "cancelling" }; }
    catch (e) { return { status: "error", error_code: "run_not_found", message: (e as Error).message, details: { run_id: runId } }; }
  }

  async addInstruction(runId: string, instruction: string): Promise<{ accepted: boolean; run_id: string; event_seq?: number } | ErrorResult> {
    if (this.eb) { await this.eb.emit({ type: "human_note", run_id: runId, source: "human", severity: "info", summary: instruction, payload: { instruction } }); }
    return { accepted: true, run_id: runId };
  }

  async ignoreRule(runId: string, ruleId: string): Promise<{ accepted: boolean; run_id: string } | ErrorResult> {
    if (this.eb) { await this.eb.emit({ type: "rule_ignored", run_id: runId, source: "human", summary: `Rule ${ruleId} ignored`, payload: { rule_id: ruleId } }); }
    return { accepted: true, run_id: runId };
  }

  async override(runId: string, decision: "continue" | "stop" | "cancel", reason?: string): Promise<{ accepted: boolean; run_id: string; action: string } | ErrorResult> {
    try {
      if (decision === "stop") {
        await (this.rm.stopRun?.(runId, reason ?? "manual override") ?? this.rm.cancel(runId, reason ?? "manual override"));
      } else if (decision === "cancel") {
        await this.rm.cancel(runId, reason ?? "manual override");
      } else {
        // "continue" → CB1 counter: record override, downgrade future auto-stop to suggest
        this.rm.onOverride?.(runId);
      }
      return { accepted: true, run_id: runId, action: decision };
    } catch (e) {
      return { status: "error", error_code: "run_not_found", message: (e as Error).message, details: { run_id: runId } };
    }
  }

  // --- Task / Memory / Skill / Hook Management ---

  async taskList() { return { status: "error", error_code: "unsupported_action", message: "Task management requires bootstrap with TaskStore" } as const; }
  async taskShow(_name: string) { return { status: "error", error_code: "unsupported_action", message: "Task management requires bootstrap with TaskStore" } as const; }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async memoryList(_targetId?: string, _category?: string) {
    if (!this.memoryStore) return { status: "error", error_code: "unsupported_action", message: "Memory store not available" } as const;
    return { status: "error", error_code: "unsupported_action", message: "Memory list requires bootstrap wiring" } as const;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async memoryConfirm(factId?: string) {
    if (!this.memoryStore || !factId) return { status: "error", error_code: "unsupported_action", message: "Fact verification requires fact_id" } as const;
    try {
      await this.memoryStore.updateFact(factId, { verified: true, source: "human_confirmed" });
      return { status: "ok" };
    } catch { return { status: "error", error_code: "not_found", message: "Fact not found" } as const; }
  }
  async memoryAdd(targetId: string, category: string, statement: string) {
    if (!this.memoryStore) return { status: "error", error_code: "unsupported_action", message: "Memory store not available" } as const;
    await this.memoryStore.writeFact({
      scope: "target", scope_id: targetId, category, statement,
      fact_id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: "human_confirmed", evidence_refs: [], verified: false,
      created_at: new Date().toISOString(),
    });
    return { status: "ok" };
  }
  async memoryDelete(factId: string) {
    if (!this.memoryStore) return { status: "error", error_code: "unsupported_action", message: "Memory store not available" } as const;
    await this.memoryStore.deleteFact(factId);
    return { status: "ok" };
  }
  async skillList() {
    if (!this.skillStore) return { skills: [] as { name: string; description: string }[], status: "ok" };
    const skills = this.skillStore.list();
    return { skills, status: "ok" };
  }
  async skillShow(name: string) {
    if (!this.skillStore) return { status: "error", error_code: "unsupported_action", message: "Skill store not available" } as const;
    const s = this.skillStore.get(name);
    if (!s) return { status: "error", error_code: "not_found", message: `Skill not found: ${name}` } as const;
    return { skill: s, status: "ok" };
  }
  async hookList() { return { status: "error", error_code: "unsupported_action", message: "Hook management requires bootstrap wiring" } as const; }
  async hookShow(_name: string) { return { status: "error", error_code: "unsupported_action", message: "Hook management requires bootstrap wiring" } as const; }
}
