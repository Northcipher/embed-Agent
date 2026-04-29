export interface LlmProvider {
  completeJson(prompt: string, systemPrompt: string): Promise<Record<string, unknown>>;
}

export class LLMDegradationBreaker {
  private failures: Map<string, number> = new Map();
  private degradedSince: Map<string, number> = new Map();
  private readonly THRESHOLD = 3;
  private readonly RECOVERY_MS = 5 * 60 * 1000;

  recordSuccess(role: string): void { this.failures.set(role, 0); this.degradedSince.delete(role); }

  recordFailure(role: string): void {
    const count = (this.failures.get(role) ?? 0) + 1;
    this.failures.set(role, count);
    if (count >= this.THRESHOLD) this.degradedSince.set(role, Date.now());
  }

  isDegraded(role: string): boolean {
    if ((this.failures.get(role) ?? 0) < this.THRESHOLD) return false;
    const since = this.degradedSince.get(role) ?? 0;
    if (Date.now() - since > this.RECOVERY_MS) {
      this.degradedSince.set(role, Date.now());
      return false;
    }
    return true;
  }
}

export class LLMCallManager {
  private breaker = new LLMDegradationBreaker();

  constructor(private provider: LlmProvider) {}

  async call(role: string, systemPrompt: string, userPrompt: string): Promise<Record<string, unknown>> {
    if (this.breaker.isDegraded(role)) {
      return this.fallbackFor(role);
    }
    try {
      const result = await this.provider.completeJson(systemPrompt, userPrompt);
      this.breaker.recordSuccess(role);
      return result;
    } catch {
      this.breaker.recordFailure(role);
      return this.fallbackFor(role);
    }
  }

  private fallbackFor(role: string): Record<string, unknown> {
    switch (role) {
      case "planner": return { status: "fallback", steps: [] };
      case "observer": return { decision: "continue" };
      case "reply": return { status: "failed", summary: "LLM unavailable" };
      default: return {};
    }
  }
}
