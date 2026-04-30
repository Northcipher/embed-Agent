import type { HookManager } from "./hook-manager.js";

interface EventEmitter {
  emit(e: Record<string, unknown>): void;
  subscribe(types: string[], handler: (e: Record<string, unknown>) => void): () => void;
}

interface ObserverCaller {
  decide(staticPrompt: string, input: Record<string, unknown>): Promise<DecisionResult>;
}

interface RunController {
  pause(runId: string, reason: string): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
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

export interface DecisionResult {
  decision: "stop" | "continue" | "collect_more" | "extend_wait" | "pause" | "suggest" | "observe_more_frequent" | "observe_again_at";
  reason: string;
  confidence: number;
  reasoning_trace: string;
  evidence_refs: string[];
  params?: {
    extra_wait_sec?: number;
    logs?: string[];
    observe_interval?: number;
    observe_at?: number;
  };
  suggestion?: string;
}

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

  constructor(
    private eb: EventEmitter,
    private hm: HookManager,
    private observer: ObserverCaller,
    private runController: RunController,
    private contextProvider: ContextProvider,
    private debounceSec = 30,
  ) {}

  /** Begin watching a run. Must be called before events arrive. */
  attach(runId: string, stepExecutor: StepController): void {
    this.runId = runId;
    this.stepExecutor = stepExecutor;
    this.overrideBreaker.reset();
    this.warningAccum.reset();
    this.debounceMap.clear();

    this.unsub?.();
    this.unsub = this.eb.subscribe(
      ["rule_matched", "checkpoint", "correlated", "baseline_diff", "human_note"],
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
    this.eb.emit({ type: "decision_overridden", source: "decision_handler", summary: "Human override" });
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const severity = (event.severity as string) ?? "info";
    const ruleId = (event.rule_id as string) ?? (event.type as string);

    // fatal → stop. Bypasses CB1/CB3.
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

    // CB3: accumulate distinct warnings
    this.warningAccum.record(ruleId);

    // debounce by rule_id
    if (this.isDebounced(ruleId)) return;

    // info → skip Observer
    if (severity === "info") return;

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

  private async executeDecision(d: DecisionResult): Promise<void> {
    this.eb.emit({
      type: "decision_made", source: "observer", run_id: this.runId,
      summary: d.reason,
      payload: { decision: d.decision, confidence: d.confidence, reasoning_trace: d.reasoning_trace },
      evidence_refs: d.evidence_refs,
    });

    switch (d.decision) {
      case "stop":
        await this.runController.cancel(this.runId, d.reason);
        break;
      case "pause":
        await this.runController.pause(this.runId, d.reason);
        break;
      case "extend_wait":
        if (d.params?.extra_wait_sec) {
          this.stepExecutor?.extendTimeout(d.params.extra_wait_sec);
        }
        break;
      case "suggest":
        this.eb.emit({
          type: "suggestion_generated", source: "observer", run_id: this.runId,
          summary: d.suggestion ?? d.reason, payload: { suggestion: d.suggestion },
        });
        break;
      // continue, collect_more, observe_more_frequent, observe_again_at → no immediate action
      default:
        break;
    }
  }
}
