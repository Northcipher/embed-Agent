import type { Decision } from "@embed-agent/contracts";
import type { HookManager } from "./hook-manager.js";

interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
  subscribe(types: string[], handler: (e: Record<string, unknown>) => void): () => void;
}

interface ObserverCaller {
  decide(staticPrompt: string, input: Record<string, unknown>): Promise<Decision>;
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
  ): Promise<{ staticPrompt: string; input: Record<string, unknown> }>;
}

export type DecisionResult = Decision;

export class ObserverOverrideBreaker {
  private overrides = 0;
  private readonly MAX = 3;

  onOverride(): void { this.overrides++; }

  isActive(): boolean { return this.overrides >= this.MAX; }

  reset(): void { this.overrides = 0; }
}

export class WarningAccumulator {
  private rules = new Set<string>();

  record(ruleId: string): void { this.rules.add(ruleId); }

  isEscalated(threshold = 5): boolean { return this.rules.size >= threshold; }

  reset(): void { this.rules.clear(); }
}

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
      ["rule_matched", "checkpoint", "correlated", "baseline_diff", "human_note"],
      e => { this.handleEvent(e); },
    );
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    // Don't reset initialized — breakers persist across steps in same run
  }

  /** Human override — CB1 counter */
  onOverride(): void {
    this.overrideBreaker.onOverride();
    this.eb.emit({ type: "decision_overridden", source: "decision_handler", summary: "Human override" });
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    // Cross-run isolation: ignore events from other runs
    if (event.run_id !== this.runId) return;

    const severity = (event.severity as string) ?? "info";
    const ruleId = (event.rule_id as string) ?? (event.type as string);

    // fatal → stop (failed path, not cancelled). Bypasses CB1/CB3.
    if (severity === "fatal") {
      const hookResult = await this.hm.execute("OnStopDecision", {
        run_id: this.runId, rule_id: ruleId, event_type: event.type, severity,
      });
      if (hookResult.decision === "block") {
        await this.runController.pause(this.runId, `OnStopDecision hook blocked: ${hookResult.reason ?? "no reason"}`);
        return;
      }
      return this.executeDecision({
        decision: "stop",
        reason: `Fatal rule "${ruleId}" matched`,
        confidence: 1.0,
        reasoning_trace: `Rule ${ruleId} severity is fatal`,
        evidence_refs: (event.evidence_refs as string[]) ?? [],
      });
    }

    // CB1: active → only suggest (never stop/pause)
    if (this.overrideBreaker.isActive()) {
      this.eb.emit({
        type: "suggestion_generated", source: "decision_handler",
        summary: `Auto-stop disabled (CB1). Rule "${ruleId}" severity=${severity}`,
        payload: { rule_id: ruleId },
      });
      return;
    }

    // debounce by rule_id
    if (this.isDebounced(ruleId)) return;

    // info → skip Observer (don't accumulate in CB3)
    if (severity === "info") return;

    // CB3: accumulate distinct warnings (only warning+ severity)
    this.warningAccum.record(ruleId);

    // warning → call Observer
    try {
      const ctx = await this.contextProvider.assembleObserverContext(
        this.runId, event,
        this.overrideBreaker.isActive(),
        this.warningAccum.isEscalated(),
      );
      const decision = await this.observer.decide(ctx.staticPrompt, ctx.input);
      await this.executeDecision(decision);
    } catch (e) {
      this.eb.emit({
        type: "decision_rejected", source: "decision_handler",
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

  private readonly VALID_DECISIONS = new Set<string>([
    "stop", "continue", "collect_more", "extend_wait", "pause", "suggest", "observe_more_frequent", "observe_again_at",
  ]);

  private validateDecision(d: DecisionResult): boolean {
    if (!this.VALID_DECISIONS.has(d.decision)) return false;
    if (typeof d.confidence !== "number" || d.confidence < 0 || d.confidence > 1) return false;
    if (typeof d.reason !== "string" || d.reason.length === 0) return false;
    return true;
  }

  private async executeDecision(d: DecisionResult): Promise<void> {
    // Validate before accepting
    if (!this.validateDecision(d)) {
      this.eb.emit({
        type: "decision_rejected", source: "decision_handler", run_id: this.runId,
        summary: `Invalid decision: ${JSON.stringify(d)}`,
        payload: { decision: d.decision },
      });
      return;
    }

    this.eb.emit({
      type: "decision_made", source: d.decision === "stop" && d.confidence === 1.0 ? "rule_reflex" : "observer",
      run_id: this.runId,
      summary: d.reason,
      payload: { decision: d.decision, confidence: d.confidence, reasoning_trace: d.reasoning_trace },
      evidence_refs: d.evidence_refs,
    });

    switch (d.decision) {
      case "stop":
        await this.runController.stopRun(this.runId, d.reason);
        break;
      case "pause":
        await this.runController.pause(this.runId, d.reason);
        break;
      case "extend_wait":
        if (d.params?.extra_wait_sec) {
          this.stepExecutor?.extendTimeout(d.params.extra_wait_sec);
        }
        break;
      case "collect_more":
        if (d.params?.logs?.length) {
          for (const logCmd of d.params.logs) {
            this.runController.appendStep?.(this.runId, {
              id: `collect_${Date.now()}`,
              capability: "collect_logs",
              action: "exec",
              command: logCmd,
              timeout_sec: 60,
            });
          }
        }
        break;
      case "suggest":
        this.eb.emit({
          type: "suggestion_generated", source: "observer", run_id: this.runId,
          summary: d.suggestion ?? d.reason, payload: { suggestion: d.suggestion },
        });
        break;
      // continue, observe_more_frequent, observe_again_at → no immediate action
      default:
        break;
    }
  }
}
