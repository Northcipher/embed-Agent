/**
 * DecisionHandler v2 — event → Observer (always LLM) → post-LLM safety net → execution.
 *
 * Changes from v1:
 *   - No fatal bypass: fatal events go through Observer like everything else.
 *   - No info skip: all severities are evaluated by Observer.
 *   - No CB1 pre-LLM early return: CB1/CB3 are post-LLM safety nets in executeDecision.
 *   - OnStopDecision hook fires in executeDecision for 'stop' decisions (post-Observer).
 *   - Observer interface simplified: decide(staticPrompt, formattedContext, runId).
 */
import type { Decision } from "@embed-agent/contracts";
import type { HookManager } from "./hook-manager.js";

interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
  subscribe(types: string[], handler: (e: Record<string, unknown>) => void): () => void;
}

interface ObserverCaller {
  decide(staticPrompt: string, formattedContext: string, runId?: string): Promise<Decision>;
}

interface RunController {
  pause(runId: string, reason: string): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
  stopRun(runId: string, reason: string): Promise<void>;
  appendStep?(runId: string, step: { id: string; capability: string; action: string; command?: string; timeout_sec: number }): void;
}

interface StepController {
  interrupt(): void;
  extendTimeout(seconds: number): void;
}

interface ContextProvider {
  assembleObserverContext(
    runId: string,
    triggeringEvent: Record<string, unknown>,
    circuitBreakerActive: boolean,
    warningEscalation: boolean,
  ): Promise<{ staticPrompt: string; formattedContext: string; knownIssues?: { fact_id: string; category: string; statement: string; extended_pattern?: string }[] }>;
}

export type DecisionResult = Decision;

// ============================================================
// CB1: ObserverOverrideBreaker
// ============================================================

export class ObserverOverrideBreaker {
  private overrides = 0;
  private readonly MAX = 3;

  onOverride(): void { this.overrides++; }

  isActive(): boolean { return this.overrides >= this.MAX; }

  reset(): void { this.overrides = 0; }
}

// ============================================================
// CB3: WarningAccumulator
// ============================================================

export class WarningAccumulator {
  private rules = new Set<string>();

  record(ruleId: string): void { this.rules.add(ruleId); }

  isEscalated(threshold = 5): boolean { return this.rules.size >= threshold; }

  reset(): void { this.rules.clear(); }
}

// ============================================================
// DecisionHandler
// ============================================================

export class DecisionHandler {
  private overrideBreaker = new ObserverOverrideBreaker();
  private warningAccum = new WarningAccumulator();
  private debounceMap = new Map<string, number>();
  private unsub: (() => void) | null = null;
  private runId = "";
  private stepExecutor: StepController | null = null;
  private initialized = false;

  constructor(
    private eb: EventEmitter,
    private hm: HookManager,
    private observer: ObserverCaller,
    private runController: RunController,
    private contextProvider: ContextProvider,
    private debounceSec = 30,
    private ignoredRules?: Set<string>, // shared across DH instances per run
  ) {}

  /** Begin watching a run. CB1/CB3 persist across steps — only reset on first attach per run. */
  attach(runId: string, stepExecutor: StepController): void {
    const isNewRun = this.runId !== runId;
    this.runId = runId;
    this.stepExecutor = stepExecutor;

    if (isNewRun || !this.initialized) {
      this.overrideBreaker.reset();
      this.warningAccum.reset();
      this.debounceMap.clear();
      this.initialized = true;
    }

    this.unsub?.();
    this.unsub = this.eb.subscribe(
      ["rule_matched", "checkpoint", "correlated", "baseline_diff", "human_note", "target_state_changed", "rule_ignored"],
      e => { this.handleEvent(e); },
    );
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** Human override — CB1 counter */
  onOverride(): void {
    this.overrideBreaker.onOverride();
  }

  // ============================================================
  // Event handling — all events go through Observer (no bypasses)
  // ============================================================

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    // Cross-run isolation
    if (event.run_id !== this.runId) return;

    const severity = (event.severity as string) ?? "info";
    const ruleId = (event.rule_id as string) ??
      `${event.type}-${(event.payload as Record<string, unknown>)?.stage ?? (event.payload as Record<string, unknown>)?.sources ?? (event.payload as Record<string, unknown>)?.metric ?? ""}`;

    // Handle rule_ignored events — add to skip set, no Observer call needed
    if (event.type === "rule_ignored") {
      const rid = (event.payload as Record<string, unknown>)?.rule_id as string;
      if (rid) this.ignoredRules?.add(rid);
      return;
    }

    // Skip if this rule was explicitly ignored by a human operator
    if (this.ignoredRules?.has(ruleId)) return;

    // Debounce by rule_id — prevent duplicate Observer calls for the same trigger
    if (this.isDebounced(ruleId)) return;

    // CB3: accumulate distinct warnings (only warning+ severity)
    if (severity === "warning" || severity === "fatal") {
      this.warningAccum.record(ruleId);
    }

    // All events → Observer (no bypasses for fatal/info/CB1)
    try {
      const ctx = await this.contextProvider.assembleObserverContext(
        this.runId, event,
        this.overrideBreaker.isActive(),
        this.warningAccum.isEscalated(),
      );
      const decision = await this.observer.decide(
        ctx.staticPrompt, ctx.formattedContext,
        this.runId,
      );
      await this.executeDecision(decision, event);
    } catch (e) {
      this.eb.emit({
        type: "decision_rejected", run_id: this.runId, source: "decision_handler",
        summary: `Observer call failed: ${(e as Error).message}`,
        payload: { rule_id: ruleId },
      });
    }
  }

  private isDebounced(ruleId: string): boolean {
    const last = this.debounceMap.get(ruleId);
    const now = Date.now();
    if (last && (now - last) < this.debounceSec * 1000) return true;
    this.debounceMap.set(ruleId, now);
    return false;
  }

  // ============================================================
  // Decision validation + post-LLM safety nets + execution
  // ============================================================

  private readonly VALID_DECISIONS = new Set<string>([
    "stop", "continue", "collect_more", "collect_evidence", "extend_wait",
    "pause", "suggest", "observe_more_frequent", "observe_again_at",
  ]);

  private validateDecision(d: DecisionResult): boolean {
    if (!this.VALID_DECISIONS.has(d.decision)) return false;
    if (typeof d.confidence !== "number" || d.confidence < 0 || d.confidence > 1) return false;
    if (typeof d.reason !== "string" || d.reason.length === 0) return false;
    return true;
  }

  private async executeDecision(d: DecisionResult, event: Record<string, unknown>): Promise<void> {
    // Validate before accepting
    if (!this.validateDecision(d)) {
      this.eb.emit({
        type: "decision_rejected", source: "decision_handler", run_id: this.runId,
        summary: `Invalid decision: ${JSON.stringify(d)}`,
        payload: { decision: d.decision },
      });
      return;
    }

    // ============================================================
    // Post-LLM safety nets — applied AFTER Observer returns
    // ============================================================

    let effectiveDecision = d.decision;
    let effectiveReason = d.reason;

    // CB1: Override breaker active → downgrade "stop" to "suggest"
    if (this.overrideBreaker.isActive() && effectiveDecision === "stop") {
      effectiveDecision = "suggest";
      effectiveReason = `[CB1] Auto-stop disabled. Original: ${d.reason}`;
    }

    // CB3: Warning escalation active + decision is "stop" (non-fatal event) → downgrade to "suggest"
    if (
      this.warningAccum.isEscalated() &&
      effectiveDecision === "stop" &&
      (event.severity as string) !== "fatal"
    ) {
      effectiveDecision = "suggest";
      effectiveReason = `[CB3] Warning escalation. Original: ${d.reason}`;
    }

    // Fatal safety net: Observer returned a non-stop decision for a fatal signal.
    // Fatal events (kernel panic, hardware fault) must stop the run.
    // Only "stop" and "pause" (human investigation) are valid responses.
    const isFatal = (event.severity as string) === "fatal";
    const nonStopping = ["continue", "collect_more", "collect_evidence", "extend_wait", "suggest", "observe_more_frequent", "observe_again_at"];
    if (isFatal && nonStopping.includes(effectiveDecision)) {
      effectiveDecision = "stop";
      effectiveReason = `[FATAL] Fatal signal requires stop. Observer returned "${d.decision}". Original: ${d.reason}`;
    }

    // Build the effective decision for emission
    const effective: Decision = {
      decision: effectiveDecision,
      reason: effectiveReason,
      confidence: d.confidence,
      reasoning_trace: d.reasoning_trace,
      evidence_refs: d.evidence_refs ?? [],
    };
    if (d.params != null) effective.params = d.params;
    if (d.suggestion != null) effective.suggestion = d.suggestion;

    // ============================================================
    // Emit decision_made event
    // ============================================================
    const source = effectiveDecision === "stop" && effective.confidence === 1.0 ? "rule_reflex" : "observer";
    this.eb.emit({
      type: "decision_made", source,
      run_id: this.runId,
      step_id: event.step_id as string | undefined,
      summary: effectiveDecision === d.decision ? d.reason : effectiveReason,
      payload: {
        decision: effectiveDecision,
        confidence: effective.confidence,
        reasoning_trace: effective.reasoning_trace,
        ...(effectiveDecision !== d.decision ? { original_decision: d.decision } : {}),
      },
      evidence_refs: effective.evidence_refs,
    });

    // ============================================================
    // Execute
    // ============================================================

    switch (effectiveDecision) {
      case "stop": {
        // OnStopDecision hook — fires post-Observer, pre-stop
        const hookResult = await this.hm.execute("OnStopDecision", {
          run_id: this.runId,
          rule_id: (event.rule_id as string) ?? event.type,
          decision_reason: effectiveReason,
          event_type: event.type,
          severity: event.severity,
        });
        if (hookResult.decision === "block") {
          await this.runController.pause(this.runId, `OnStopDecision hook blocked stop: ${hookResult.reason ?? "no reason"}`);
          break;
        }
        await this.runController.stopRun(this.runId, effectiveReason);
        break;
      }
      case "pause":
        await this.runController.pause(this.runId, effectiveReason);
        break;
      case "extend_wait":
        if (effective.params?.extra_wait_sec) {
          this.stepExecutor?.extendTimeout(effective.params.extra_wait_sec);
        }
        break;
      case "collect_more":
      case "collect_evidence": {
        const cmds = effective.params?.logs ?? effective.params?.commands;
        if (cmds?.length) {
          const timeout = effective.params?.timeout_sec ?? 60;
          let idx = 0;
          for (const cmd of cmds) {
            this.runController.appendStep?.(this.runId, {
              id: `collect_${Date.now()}_${idx++}`,
              capability: "collect_logs",
              action: "exec",
              command: cmd,
              timeout_sec: timeout,
            });
          }
        }
        break; }
      case "suggest":
        this.eb.emit({
          type: "suggestion_generated", source: "observer", run_id: this.runId,
          summary: effective.suggestion ?? effectiveReason, payload: { suggestion: effective.suggestion },
        });
        break;
      case "observe_more_frequent":
        // Halve debounce to increase Observer responsiveness
        this.debounceSec = Math.max(5, Math.floor(this.debounceSec / 2));
        this.eb.emit({
          type: "observation", run_id: this.runId, source: "decision_handler", severity: "info",
          summary: `Observation frequency increased (debounce now ${this.debounceSec}s)`,
          payload: { new_debounce_sec: this.debounceSec },
        });
        break;
      case "observe_again_at":
        this.eb.emit({
          type: "observation", run_id: this.runId, source: "decision_handler", severity: "info",
          summary: `Observer scheduled re-check at +${effective.params?.observe_at ?? "?"}s`,
          payload: { observe_at: effective.params?.observe_at },
        });
        break;
      // continue → no immediate action
      default:
        break;
    }
  }
}
