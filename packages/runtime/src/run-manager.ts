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
  getState(targetId: string): Promise<{ state: string; current_run_id?: string; target_id?: string } | null>;
  updateState(targetId: string, patch: Record<string, unknown>): Promise<void>;
  listStates?(): Promise<{ target_id: string; state: string; current_run_id?: string }[]>;
}

// --- Interfaces for Agent layer ---

interface PlanCallResult {
  status: "planned" | "clarification_needed";
  plan?: { plan_id: string; estimated_duration_sec: number; steps: Step[]; evidence_policy: { always: string[]; on_failure: string[] }; success_criteria: string[]; failure_signals: string[] };
  missing_info?: string[];
  suggested_next?: string;
}

interface PlannerCaller {
  call(staticPrompt: string, dynamicContext: Record<string, unknown>, runId?: string): Promise<PlanCallResult>;
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
  acquireLock(targetId: string, runId: string): Promise<boolean>;
  releaseLock(targetId: string): Promise<void>;
  transitionState(targetId: string, to: string): Promise<void>;
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
  subscribe?: (types: string[], handler: (e: Record<string, unknown>) => void) => () => void;
}

// --- Helper ---

function generateId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- RunManager ---

export class RunManager {
  private activeExecutors = new Map<string, StepExecutor>();
  private activeDecisionHandlers = new Map<string, DecisionHandler>();
  private stepQueues = new Map<string, StepQueue>();

  // Factories injected by bootstrap — avoid stubs in executeRun
  private executorFactory?: (runId: string, targetId: string) => StepExecutor | Promise<StepExecutor>;
  private dhFactory?: (runId: string) => DecisionHandler;

  setExecutorFactory(fn: (runId: string, targetId: string) => StepExecutor | Promise<StepExecutor>): void { this.executorFactory = fn; }
  setDecisionHandlerFactory(fn: (runId: string) => DecisionHandler): void { this.dhFactory = fn; }

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
  // Host crash recovery
  // ============================================================

  /** Recover from host crash on startup. Detects stale non-terminal runs, fails them, cleans locks. */
  async recoverOnStartup(): Promise<{ recovered: number; cleaned_locks: number }> {
    const runs = await this.runStore.listNonTerminal();
    let recovered = 0;
    let cleanedLocks = 0;

    for (const run of runs) {
      const elapsed = Date.now() - new Date(run.created_at).getTime();
      const staleThreshold = 30 * 60 * 1000; // 30 min stale

      switch (run.state) {
        case "running":
        case "collecting_evidence": {
          // Read last event to check staleness
          const events = await this.eventStoreRead(run.run_id, Math.max(0, run.last_event_seq - 1), 2);
          const lastEvent = events[events.length - 1];
          const lastEventAge = lastEvent ? Date.now() - new Date(lastEvent.time).getTime() : elapsed;

          if (lastEventAge > staleThreshold) {
            await this.finalize(run.run_id, run.target_id, "failed", `Host crash: run stale (last event ${Math.round(lastEventAge / 60000)}m ago)`);
            recovered++;
          }
          break;
        }
        case "planning":
        case "finalizing": {
          // These states are always stale after crash — the host was mid-operation
          if (elapsed > staleThreshold) {
            await this.finalize(run.run_id, run.target_id, "failed", `Host crash during ${run.state}`);
            recovered++;
          }
          break;
        }
        case "paused":
          // Leave paused runs as-is (human intervention was pending)
          break;
      }
    }

    // Clean up stale target locks: any target with current_run_id where the run is terminal
    const states = await this.targetState.listStates?.() ?? [];
    for (const s of states) {
      if (!s.current_run_id) continue;
      const run = await this.runStore.get(s.current_run_id);
      if (!run || ["completed", "failed", "cancelled"].includes(run.state)) {
        await this.tm.releaseLock(s.target_id);
        cleanedLocks++;
      }
    }

    return { recovered, cleaned_locks: cleanedLocks };
  }

  // EventStore reader — optionally injected for crash recovery
  private eventReader?: { read(runId: string, afterSeq?: number, limit?: number): Promise<{ time: string }[]> };
  setEventReader(reader: { read(runId: string, afterSeq?: number, limit?: number): Promise<{ time: string }[]> }): void {
    this.eventReader = reader;
  }

  private async eventStoreRead(runId: string, afterSeq: number, limit: number): Promise<{ time: string }[]> {
    return this.eventReader?.read(runId, afterSeq, limit) ?? [];
  }

  // ============================================================
  // createRun — full admission
  // ============================================================

  async createRun(req: ValidateRequest): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }> {
    // 1. Validate params
    if (!req.artifact?.path || !req.target || !req.expected) {
      return { status: "invalid_request", reasons: ["artifact.path, target, and expected are required"] };
    }

    // 2. Acquire target lock (atomic check-busy + set preparing via TargetManager)
    const runId = generateId();
    const locked = await this.tm.acquireLock(req.target, runId);
    if (!locked) {
      return { status: "target_busy", reasons: [`Target ${req.target} is busy`] };
    }

    // 3. Create Run record
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

    // 4. PreRunStart hook
    const hookResult = await this.hm.execute("PreRunStart", {
      run_id: runId, target_id: req.target, artifact: req.artifact,
    });
    if (hookResult.decision === "block") {
      return await this.rejectRun(runId, req.target, `PreRunStart hook blocked: ${hookResult.reason ?? "no reason"}`, "rejected");
    }

    // 5. ContextAssembler → Planner → Plan
    let planResult: PlanCallResult;
    try {
      const taskInfo: { task: string; expected: string; concerns?: string[]; constraints?: Record<string, unknown>; test_hint?: unknown } = {
        task: `Validate ${req.artifact.type} on ${req.target}`,
        expected: req.expected,
        constraints: req.constraints as unknown as Record<string, unknown>,
        test_hint: req.test_hint,
      };
      if (req.concerns) taskInfo.concerns = req.concerns;
      const ctx = await this.contextAssembler.assemblePlannerContext(runId, taskInfo);
      planResult = await this.planner.call(ctx.staticPrompt, ctx.dynamicContext, runId);
    } catch (e) {
      return await this.rejectRun(runId, req.target, `Plan generation failed: ${(e as Error).message}`, "plan_rejected");
    }

    // Handle clarification_needed from Planner — release lock, finalize as failed
    if (planResult.status === "clarification_needed") {
      await this.finalize(runId, req.target, "failed", `Clarification needed: ${planResult.missing_info?.join(", ") ?? "unknown"}`);
      return {
        status: "clarification_needed", run_id: runId,
        reasons: planResult.missing_info ?? ["Planner needs more information"],
      };
    }

    const plan = planResult.plan!;

    // 6. Validate plan — safety constraints
    if (!plan.steps || plan.steps.length === 0) {
      return await this.rejectRun(runId, req.target, "Plan rejected: no steps generated", "plan_rejected");
    }
    const allowFlash = req.constraints?.allow_flash ?? true;
    const allowShell = req.constraints?.allow_shell_exec ?? true;
    for (const step of plan.steps) {
      if (step.action === "flash" && !allowFlash) {
        return await this.rejectRun(runId, req.target, `Plan rejected: flash step "${step.id}" blocked by allow_flash=false`, "plan_rejected");
      }
      if (step.capability === "shell_exec" && !allowShell) {
        return await this.rejectRun(runId, req.target, `Plan rejected: shell_exec step "${step.id}" blocked by allow_shell_exec=false`, "plan_rejected");
      }
    }

    // 7. Pre-flight — derive required transports from plan steps
    const transports = this.requiredTransports(plan.steps, req.constraints?.no_flash ?? false);
    const pf = await this.tm.preflight(req.target, transports, req.artifact.path);
    if (!pf.all_passed) {
      return await this.rejectRun(runId, req.target, "Pre-flight failed", "target_not_ready", pf.checks.map(c => ({ check: c.check, error: c.error ?? "failed" })));
    }

    // 8. Emit RunStarted FIRST (await — event must land before state advances)
    await this.eb.emit({
      type: "run_started", run_id: runId, source: "run_manager",
      summary: `Run ${runId} started on target ${req.target}`,
      payload: {
        plan_id: plan.plan_id, target_id: req.target, estimated_duration_sec: plan.estimated_duration_sec,
        success_criteria: plan.success_criteria, failure_signals: plan.failure_signals,
        evidence_policy: plan.evidence_policy,
      },
    });

    // Then advance state
    await Promise.all([
      this.runStore.update(runId, { state: "running", started_at: new Date().toISOString() }),
      this.tm.transitionState(req.target, "busy"),
    ]);

    const sq = new StepQueue();
    sq.load(plan.steps);
    this.stepQueues.set(runId, sq);

    // Start async execution — don't await, let it run in background
    this.executeRun(runId, req.target).catch(async (e) => {
      console.error(`[RunManager] Background execution failed for ${runId}:`, (e as Error).message);
      await this.finalize(runId, req.target, "failed", `Execution error: ${(e as Error).message}`);
    });

    return { status: "accepted", run_id: runId };
  }

  /**
   * Execute all steps in a run. Uses injected StepExecutor + DecisionHandler factories.
   * Must be called after setExecutorFactory / setDecisionHandlerFactory are configured.
   */
  async executeRun(runId: string, targetId: string): Promise<void> {
    const sq = this.stepQueues.get(runId);
    if (!sq) return;

    if (!this.executorFactory || !this.dhFactory) {
      throw new Error("executeRun called before executorFactory/dhFactory were injected — call setExecutorFactory/setDecisionHandlerFactory from bootstrap");
    }

    const executor = await this.executorFactory(runId, targetId);
    const dh = this.dhFactory(runId);

    // Execute steps until done
    let hasMore = true;
    while (hasMore) {
      hasMore = await this.runNextStep(runId, executor, dh);
    }
  }

  private async rejectRun(
    runId: string, targetId: string, reason: string, status: string,
    failedChecks?: { check: string; error: string }[],
  ): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }> {
    await this.finalize(runId, targetId, "failed", reason);
    const result: { status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] } = { status, run_id: runId, reasons: [reason] };
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

    // 2. State transitions: completed → collecting_evidence → finalizing; failed/cancelled → finalizing
    if (status === "completed") {
      await this.runStore.update(runId, { state: "collecting_evidence" });
      await this.eb.emit({ type: "run_paused", run_id: runId, source: "run_manager", summary: "Collecting final evidence", payload: { phase: "collecting_evidence" } });
    }
    await this.runStore.update(runId, { state: "finalizing" });

    // 3. OnFinalizing hook
    await this.hm.execute("OnFinalizing", { run_id: runId, status, reason });

    // 3. Reply generates result. Reply is the ONLY result_ready publisher.
    let reply: AgentReply;
    try {
      if (status === "cancelled") {
        reply = await this.reply.generateCancelled(runId, reason);
      } else if (status === "completed") {
        // Normal completion — LLM-driven reply with full event analysis
        reply = await this.reply.generate(runId);
      } else {
        // Failed (early failure) — rule-based minimal reply
        reply = await this.reply.generateMinimal(runId, reason);
      }
    } catch (e) {
      console.error(`[RunManager] Reply generation failed for ${runId}:`, (e as Error).message);
      reply = {
        run_id: runId, status,
        summary: reason, suggested_next: "check evidence manually", evidence_path: `${this.dataRoot}/runs/${runId}`,
        key_evidence: [],
      };
    }

    // 4. RM emits audit event FIRST, then updates state.
    const auditType = `run_${reply.status}`;
    await this.eb.emit({
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

    // 5. Release lock via TargetManager (cleaning → idle transition)
    await this.tm.releaseLock(targetId);

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
    await this.eb.emit({ type: "run_paused", run_id: runId, source: "run_manager", summary: reason, payload: {} });
    await this.runStore.update(runId, { state: "paused" });
  }

  async resume(runId: string): Promise<void> {
    const sq = this.stepQueues.get(runId);
    if (!sq) throw new Error(`Run not active: ${runId}`);
    sq.resume();
    await this.eb.emit({ type: "run_resumed", run_id: runId, source: "run_manager", summary: "Run resumed", payload: {} });
    await this.runStore.update(runId, { state: "running" });
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.activeExecutors.get(runId)?.interrupt();
    await this.finalize(runId, run.target_id, "cancelled", reason);
  }

  /** Append a step to the run's StepQueue (from collect_more decision). */
  appendStep(runId: string, step: { id: string; capability: string; action: string; command?: string; timeout_sec: number }): void {
    const sq = this.stepQueues.get(runId);
    if (sq) sq.append(step as never);
  }

  /** Record a human override on the active DecisionHandler (CB1 counter). */
  onOverride(runId: string): void {
    this.activeDecisionHandlers.get(runId)?.onOverride();
  }

  /** Stop a run due to fatal signal — uses "failed" path, not "cancelled". */
  async stopRun(runId: string, reason: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.activeExecutors.get(runId)?.interrupt();
    await this.finalize(runId, run.target_id, "failed", reason);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private requiredTransports(steps: Step[], noFlash: boolean): string[] {
    const needed = new Set<string>();
    for (const s of steps) {
      switch (s.capability) {
        case "serial_output": needed.add("serial"); break;
        case "shell_exec":
        case "wait_adb":
        case "collect_logs":
        case "adb_logs": needed.add("adb"); break;
        case "flash": if (!noFlash) needed.add("fastboot"); break;
        case "ssh_exec": needed.add("ssh"); break;
        case "local_exec": needed.add("local"); break;
      }
    }
    // Always include serial + adb as fallback if nothing specific
    if (needed.size === 0) return ["serial", "adb"];
    return [...needed];
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
      if (result.blocked) {
        // Hook blocked — treat as pause, not failure
        await this.pause(runId, result.error ?? "Hook blocked step");
        return false;
      }
      // Step failed — finalize as failed
      await this.finalize(runId, executor["target"]?.target_id ?? "", "failed", result.error ?? "Step failed");
      return false;
    }

    return true;
  }
}
