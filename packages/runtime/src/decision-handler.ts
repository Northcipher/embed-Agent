import type { Decision, Event } from "@embed-agent/contracts";
import type { EventBus } from "./event-bus.js";

export class DecisionHandler {
  private observerOverrideCount = 0;
  private warningRuleIds = new Set<string>();

  constructor(private eventBus: EventBus) {}

  async handleEvent(_event: Event): Promise<void> {
    // Full implementation in later iteration
  }

  async executeDecision(_decision: Decision): Promise<void> {
    // Full implementation in later iteration
  }

  onOverride(): void {
    this.observerOverrideCount++;
  }

  isObserverBreakerActive(): boolean {
    return this.observerOverrideCount >= 3;
  }

  recordWarning(ruleId: string): void {
    this.warningRuleIds.add(ruleId);
  }

  isWarningEscalated(): boolean {
    return this.warningRuleIds.size >= 5;
  }

  resetForNewRun(): void {
    this.observerOverrideCount = 0;
    this.warningRuleIds.clear();
  }
}
