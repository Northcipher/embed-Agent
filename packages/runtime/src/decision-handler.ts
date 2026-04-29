import type { Decision } from "@embed-agent/contracts";
import type { EventBus } from "./event-bus.js";

export type Severity = "fatal" | "warning" | "info";

export class DecisionHandler {
  private observerOverrideCount = 0;
  private warningRuleIds = new Set<string>();
  private debounceTimers: Map<string, number> = new Map();
  private readonly DEBOUNCE_MS = 30_000;

  constructor(
    private eventBus: EventBus,
    private stepExecutor: { interrupt(): void; extendTimeout(s: number): void },
    private stepQueue: { append(s: Record<string, unknown>): void; clear(): void; pause(): void },
    private observer?: { decide(sp: string, input: Record<string, unknown>): Promise<Decision> },
    private contextAssembler?: { assembleObserverContext(rid: string, e: Record<string, unknown>): Promise<{ staticPrompt: string; input: Record<string, unknown> }> },
  ) {}

  async handleEvent(event: Record<string, unknown>): Promise<void> {
    const severity = (event.severity as Severity) ?? "warning";
    const ruleId = (event.rule_id as string) ?? (event.type as string);
    const runId = event.run_id as string;

    if (severity === "fatal") {
      await this.executeStop(event);
      return;
    }

    if (this.isObserverBreakerActive()) {
      this.eventBus.emit({ type: "suggestion_generated", run_id: runId, source: "decision_handler", summary: "Auto-stop disabled", payload: {} });
      return;
    }

    this.recordWarning(ruleId);

    if (this.isDebounced(ruleId)) return;
    this.setDebounce(ruleId);

    // Delegate to Observer
    if (this.observer && this.contextAssembler) {
      try {
        const ctx = await this.contextAssembler.assembleObserverContext(runId, event);
        const decision = await this.observer.decide(ctx.staticPrompt, {
          ...ctx.input,
          circuitBreakerActive: this.isObserverBreakerActive(),
          warningEscalation: this.isWarningEscalated(),
        });
        await this.executeDecision(decision);
        this.eventBus.emit({ type: "decision_made", source: "observer", run_id: runId, payload: decision });
      } catch {
        // Observer failed → fallback
        if (severity === "fatal") {
          await this.executeStop(event);
        }
      }
    }
  }

  async executeDecision(decision: Decision): Promise<void> {
    switch (decision.decision) {
      case "stop":
        this.stepExecutor.interrupt();
        this.stepQueue.clear();
        break;
      case "pause":
        this.stepExecutor.interrupt();
        this.stepQueue.pause();
        break;
      case "extend_wait":
        if (decision.params?.extra_wait_sec) {
          this.stepExecutor.extendTimeout(decision.params.extra_wait_sec);
        }
        break;
      case "collect_more":
        if (decision.params?.logs) {
          for (const log of decision.params.logs) {
            this.stepQueue.append({ id: `extra-${log}`, action: "exec", capability: "collect_logs", command: log, timeout: 60, condition: "always", on_failure: "continue" });
          }
        }
        break;
      // continue, suggest, etc. → no action
    }
  }

  private async executeStop(event: Record<string, unknown>): Promise<void> {
    this.stepExecutor.interrupt();
    this.stepQueue.clear();
    this.eventBus.emit({ type: "decision_made", source: "rule", run_id: event.run_id, summary: "fatal rule stop", payload: event });
  }

  onOverride(): void { this.observerOverrideCount++; }
  isObserverBreakerActive(): boolean { return this.observerOverrideCount >= 3; }
  recordWarning(ruleId: string): void { this.warningRuleIds.add(ruleId); }
  isWarningEscalated(): boolean { return this.warningRuleIds.size >= 5; }
  resetForNewRun(): void { this.observerOverrideCount = 0; this.warningRuleIds.clear(); }

  private isDebounced(ruleId: string): boolean {
    const last = this.debounceTimers.get(ruleId);
    return last != null && (Date.now() - last) < this.DEBOUNCE_MS;
  }
  private setDebounce(ruleId: string): void { this.debounceTimers.set(ruleId, Date.now()); }
}
