import type { LLMCallManager, LLMMessage } from "./llm.js";
import type { Decision } from "./types.js";

export interface ObserverInput {
  run: { state: string; elapsed_sec: number; current_step_id?: string };
  target?: { serial_state: string; adb_state: string };
  triggering_event: Record<string, unknown>;
  signals?: { type: string; summary: string; severity?: string }[];
  evidence_windows?: { ref: string; text: string }[];
  checkpoint_history?: { metrics: Record<string, number>; trend: string }[];
  memory: {
    working_memory: { key: string; summary: string; source: string }[];
    known_issues: { fact_id: string; category: string; statement: string }[];
  };
  constraints: { remaining_sec: number; allowed_capabilities: string[] };
  circuit_breaker_active?: boolean;
  warning_escalation?: boolean;
}

const OBSERVER_FALLBACKS: Record<string, Decision["decision"]> = {
  fatal: "stop",
  target_state_changed: "pause",
};

export class Observer {
  constructor(private llm: LLMCallManager) {}

  async decide(staticPrompt: string, input: ObserverInput): Promise<Decision> {
    const messages: LLMMessage[] = [
      { role: "system", content: staticPrompt },
      { role: "user", content: JSON.stringify(input, null, 2) },
    ];

    try {
      const result = await this.llm.call("observer", messages);
      if ("status" in result) {
        // CB4 degraded — use severity-based fallback
        return this.fallbackDecision(input);
      }

      return this.parseDecision(result.content, input);
    } catch {
      // LLM failure — use severity-based fallback
      return this.fallbackDecision(input);
    }
  }

  private parseDecision(content: string, input: ObserverInput): Decision {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
      const parsed = JSON.parse(json) as Decision;

      // Validate
      const validDecisions = ["stop", "continue", "collect_more", "extend_wait", "pause", "suggest", "observe_more_frequent", "observe_again_at"];
      if (!validDecisions.includes(parsed.decision)) {
        return this.fallbackDecision(input);
      }
      if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
        parsed.confidence = 0.5;
      }

      const result: Decision = {
        decision: parsed.decision,
        reason: parsed.reason ?? "no reason provided",
        confidence: parsed.confidence,
        reasoning_trace: parsed.reasoning_trace ?? "",
        evidence_refs: parsed.evidence_refs ?? [],
      };
      if (parsed.params) result.params = parsed.params;
      if (parsed.suggestion) result.suggestion = parsed.suggestion;
      return result;
    } catch {
      return this.fallbackDecision(input);
    }
  }

  private fallbackDecision(input: ObserverInput): Decision {
    const severity = (input.triggering_event.severity as string) ?? "info";
    const eventType = input.triggering_event.type as string;

    // Severity-based fallback
    const fallbackAction = OBSERVER_FALLBACKS[severity] ?? OBSERVER_FALLBACKS[eventType] ?? "continue";

    return {
      decision: fallbackAction,
      reason: `Fallback: severity=${severity}, event=${eventType}`,
      confidence: 0.3,
      reasoning_trace: "Observer LLM call failed — using fallback decision",
      evidence_refs: [],
    };
  }
}
