import type { RunRecord, RunState } from "@embed-agent/stores";
import type { HookManager } from "./hook-manager.js";
import { StepQueue, type Step } from "./step-queue.js";
import type { StepExecutor } from "./step-executor.js";
import type { DecisionHandler } from "./decision-handler.js";
import type { ContextAssembler } from "./context-assembler.js";

// --- Interfaces for Store layer ---

interface RunStoreIO {
  create(run: RunRecord): Promise<void>;
  update(runId: string, patch: Partial<RunRecord>): Promise<void>;
  get(runId: string): Promise<RunRecord | null>;
  listNonTerminal(): Promise<RunRecord[]>;
}

interface TargetStateIO {
  getState(targetId: string): Promise<{ state: string; current_run_id?: string } | null>;
  updateState(targetId: string, patch: Record<string, unknown>): Promise<void>;
}

// --- Interfaces for Agent layer ---

interface PlanResult {
  plan_id: string;
  estimated_duration_sec: number;
  steps: Step[];
  evidence_policy: { always: string[]; on_failure: string[] };
  success_criteria: string[];
  failure_signals: string[];
}

interface PlannerCaller {
  call(staticPrompt: string, dynamicContext: Record<string, unknown>): Promise<PlanResult>;
}

interface AgentReply {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  suggested_next: string;
  evidence_path: string;
  key_evidence: { summary: string; evidence_refs: string[] }[];
}

interface ReplyCaller {
  generate(runId: string): Promise<AgentReply>;
  generateMinimal(runId: string, reason: string): Promise<AgentReply>;
  generateCancelled(runId: string, reason: string): Promise<AgentReply>;
}

// --- Interfaces for Tool layer ---

interface TargetManagerIO {
  isBusy(state: { state: string } | null): boolean;
  preflight(targetId: string, transports: string[], artifactPath: string): Promise<{ all_passed: boolean; checks: { check: string; passed: boolean; error?: string }[]; failure_type?: string }>;
  recover(targetId: string): Promise<boolean>;
}

// --- Request types ---

export interface ValidateRequest {
  artifact: { path: string; type: string; version?: string; build_id?: string };
  target: string;
  expected: string;
  concerns?: string[];
  test_hint?: { kind: string; command: string; timeout_sec?: number; expected_exit_code?: number };
  constraints?: {
    max_duration_sec?: number;
    allow_flash?: boolean;
    allow_shell_exec?: boolean;
    no_flash?: boolean;
    continuous?: boolean;
  };
}

// --- Event emitter interface ---

interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

// --- Helper ---

function generateId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function publishResultReady(eb: EventEmitter, reply: AgentReply): void {
  eb.emit({
    type: "result_ready", run_id: reply.run_id, source: "reply_generator",
    summary: reply.summary,
    payload: {
      status: reply.status, summary: reply.summary,
      suggested_next: reply.suggested_next, evidence_path: reply.evidence_path,
      key_evidence: reply.key_evidence,
    },
  });
}

// --- RunManager ---

export class RunManager {
  private activeExecutors = new Map<string, StepExecutor>();
  private activeDecisionHandlers = new Map<string, DecisionHandler>();
  private stepQueues = new Map<string, StepQueue>();

  constructor(
    private runStore: RunStoreIO,
    private targetState: TargetStateIO,
    private tm: TargetManagerIO,
    private eb: EventEmitter,
    private hm: HookManager,
    private contextAssembler: ContextAssembler,
    private planner: PlannerCaller,
    private reply: ReplyCaller,
    private dataRoot = ".embed-agent",
  ) {}

  // ============================================================
  // createRun — full admission
  // ============================================================

  async createRun(req: ValidateRequest): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }> {
    // 1. Validate params
    if (!req.artifact?.path || !req.target || !req.expected) {
      return { status: "invalid_request", reasons: ["artifact.path, target, and expected are required"] };
    }

    // 2. Check Target.busy
    const ts = await this.targetState.getState(req.target);
    if (this.tm.isBusy(ts)) {
      return { status: "target_busy", reasons: [`Target ${req.target} is in state ${ts?.state ?? "unknown"}`] };
    }

    // 3. Create Run + acquire lock (set target to preparing)
    const runId = generateId();
    const run: RunRecord = {
      run_id: runId,
      session_id: `session-${Date.now()}`,
      state: "planning",
      target_id: req.target,
      artifact: req.artifact,
      elapsed_sec: 0,
      last_event_seq: 0,
      evidence_root: `${this.dataRoot}/runs/${runId}`,
      created_at: new Date().toISOString(),
    };
    await this.runStore.create(run);
    await this.targetState.updateState(req.target, { state: "preparing", current_run_id: runId });

    // 4. PreRunStart hook
    const hookResult = await this.hm.execute("PreRunStart", {
      run_id: runId, target_id: req.target, artifact: req.artifact,
    });
    if (hookResult.decision === "block") {
      return await this.rejectRun(runId, req.target, `PreRunStart hook blocked: ${hookResult.reason ?? "no reason"}`);
    }

    // 5. ContextAssembler → Planner → Plan
    let plan: PlanResult;
    try {
      const ctx = await this.contextAssembler.assemblePlannerContext(runId);
      plan = await this.planner.call(ctx.staticPrompt, ctx.dynamicContext);
    } catch (e) {
      return await this.rejectRun(runId, req.target, `Plan generation failed: ${(e as Error).message}`);
    }

    // 6. Validate plan
    if (!plan.steps || plan.steps.length === 0) {
      return await this.rejectRun(runId, req.target, "Plan rejected: no steps generated");
    }

    // 7. Pre-flight
    const transports = req.constraints?.no_flash ? ["serial", "adb"] : ["serial", "adb", "fastboot"];
    const pf = await this.tm.preflight(req.target, transports, req.artifact.path);
    if (!pf.all_passed) {
      return await this.rejectRun(runId, req.target, "Pre-flight failed", pf.checks.map(c => ({ check: c.check, error: c.error ?? "failed" })));
    }

    // 8. Emit RunStarted → update state (running + target busy) → load steps
    this.eb.emit({
      type: "run_started", run_id: runId, source: "run_manager",
      summary: `Run ${runId} started on target ${req.target}`,
      payload: { plan_id: plan.plan_id, target_id: req.target, estimated_duration_sec: plan.estimated_duration_sec },
    });

    await Promise.all([
      this.runStore.update(runId, { state: "running", started_at: new Date().toISOString() }),
      this.targetState.updateState(req.target, { state: "busy" }),
    ]);

    const sq = new StepQueue();
    sq.load(plan.steps);
    this.stepQueues.set(runId, sq);

    return { status: "accepted", run_id: runId };
  }

  private async rejectRun(
    runId: string, targetId: string, reason: string,
    failedChecks?: { check: string; error: string }[],
  ): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }> {
    await this.finalize(runId, targetId, "failed", reason);
    const result: { status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] } = { status: "plan_rejected", run_id: runId, reasons: [reason] };
    if (failedChecks) result.failed_checks = failedChecks;
    return result;
  }

  // ============================================================
  // finalize — unified exit path
  // ============================================================

  private async finalize(runId: string, targetId: string, status: "completed" | "failed" | "cancelled", reason: string): Promise<void> {
    // 1. Detach decision handler & executor
    this.activeDecisionHandlers.get(runId)?.detach();
    this.activeDecisionHandlers.delete(runId);
    this.activeExecutors.delete(runId);

    // 2. OnFinalizing hook
    await this.hm.execute("OnFinalizing", { run_id: runId, status, reason });

    // 3. Reply generates result. Reply is the ONLY result_ready publisher.
    //    Fallback path also publishes result_ready so it's never skipped.
    let reply: AgentReply;
    try {
      if (status === "cancelled") {
        reply = await this.reply.generateCancelled(runId, reason);
      } else {
        reply = await this.reply.generateMinimal(runId, reason);
      }
    } catch {
      reply = {
        run_id: runId, status,
        summary: reason, suggested_next: "check evidence manually", evidence_path: `${this.dataRoot}/runs/${runId}`,
        key_evidence: [],
      };
      // Ensure result_ready is published even when ReplyCaller fails
      publishResultReady(this.eb, reply);
    }

    // 4. RM emits audit event FIRST, then updates state.
    const auditType = `run_${reply.status}`;
    this.eb.emit({
      type: auditType, run_id: runId, source: "run_manager",
      summary: reply.summary,
      payload: { status: reply.status, key_evidence: reply.key_evidence, evidence_path: reply.evidence_path, suggested_next: reply.suggested_next },
    });

    const updatePatch: Partial<RunRecord> = {
      state: reply.status as RunState,
      ended_at: new Date().toISOString(),
    };
    if (reply.status !== "completed") updatePatch.failure_reason = reason;
    await this.runStore.update(runId, updatePatch);

    // 5. Release lock — target back to idle
    await this.targetState.updateState(targetId, { state: "idle", current_run_id: undefined });

    // 6. PostRunEnd hook
    await this.hm.execute("PostRunEnd", { run_id: runId, status: reply.status });
  }

  // ============================================================
  // pause / resume / cancel / stop (fatal)
  // ============================================================

  async pause(runId: string, reason: string): Promise<void> {
    const sq = this.stepQueues.get(runId);
    if (!sq) throw new Error(`Run not active: ${runId}`);
    sq.pause();
    this.activeExecutors.get(runId)?.interrupt();
    this.eb.emit({ type: "run_paused", run_id: runId, source: "run_manager", summary: reason, payload: {} });
    await this.runStore.update(runId, { state: "paused" });
  }

  async resume(runId: string): Promise<void> {
    const sq = this.stepQueues.get(runId);
    if (!sq) throw new Error(`Run not active: ${runId}`);
    sq.resume();
    this.eb.emit({ type: "run_resumed", run_id: runId, source: "run_manager", summary: "Run resumed", payload: {} });
    await this.runStore.update(runId, { state: "running" });
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.activeExecutors.get(runId)?.interrupt();
    await this.finalize(runId, run.target_id, "cancelled", reason);
  }

  /** Stop a run due to fatal signal — uses "failed" path, not "cancelled". */
  async stopRun(runId: string, reason: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.activeExecutors.get(runId)?.interrupt();
    await this.finalize(runId, run.target_id, "failed", reason);
  }

  // ============================================================
  // Step execution loop
  // ============================================================

  getStepQueue(runId: string): StepQueue | undefined {
    return this.stepQueues.get(runId);
  }

  async runNextStep(runId: string, executor: StepExecutor, dh: DecisionHandler): Promise<boolean> {
    const sq = this.stepQueues.get(runId);
    if (!sq) return false;

    const step = sq.next();
    if (!step) {
      // No more steps — begin finalization
      await this.finalize(runId, executor["target"]?.target_id ?? "", "completed", "All steps completed");
      return false;
    }

    this.activeExecutors.set(runId, executor);
    this.activeDecisionHandlers.set(runId, dh);

    dh.attach(runId, executor);
    const result = await executor.executeStep(step);
    dh.detach();

    if (!result.completed) {
      if (result.interrupted) {
        // Interrupted by pause/cancel — leave as-is (caller handles)
        return false;
      }
      // Step failed — finalize as failed
      await this.finalize(runId, executor["target"]?.target_id ?? "", "failed", result.error ?? "Step failed");
      return false;
    }

    return true;
  }
}
