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

interface MemoryWriter {
  writeWorkingMemory(runId: string, entry: { key: string; summary: string; source: "observer" | "planner" | "human" }): Promise<void>;
}

const OBSERVER_FALLBACKS: Record<string, Decision["decision"]> = {
  fatal: "stop",
  target_state_changed: "pause",
};

export class Observer {
  private memory: MemoryWriter | undefined;

  constructor(private llm: LLMCallManager, memory?: MemoryWriter) {
    this.memory = memory;
  }

  async decide(staticPrompt: string, input: ObserverInput, runId?: string): Promise<Decision> {
    // 4.3.5 Semantic variant matching: check known_issues BEFORE calling LLM
    const knownMatch = this.matchKnownIssue(input);
    if (knownMatch) {
      const decision: Decision = {
        decision: "continue",
        reason: `Known issue matched: ${knownMatch}`,
        confidence: 0.9,
        reasoning_trace: `Semantic variant of known issue detected — continuing`,
        evidence_refs: [],
      };
      if (runId) this.memory?.writeWorkingMemory(runId, { key: "known_issue_match", summary: knownMatch, source: "observer" });
      return decision;
    }

    const messages: LLMMessage[] = [
      { role: "system", content: staticPrompt },
      { role: "user", content: JSON.stringify(input, null, 2) },
    ];

    let decision: Decision;
    try {
      const result = await this.llm.call("observer", messages);
      if ("status" in result) {
        decision = this.fallbackDecision(input);
      } else {
        decision = this.parseDecision(result.content, input);
      }
    } catch {
      decision = this.fallbackDecision(input);
    }

    // 4.3.6 Write decision reasoning to Working Memory
    if (runId) {
      this.memory?.writeWorkingMemory(runId, {
        key: `observer_decision_${Date.now()}`,
        summary: `[${decision.decision}] ${decision.reason}`,
        source: "observer",
      }).catch(() => { /* non-fatal */ });
    }

    return decision;
  }

  /** Check if the triggering event matches any known issue pattern (semantic variant). */
  private matchKnownIssue(input: ObserverInput): string | null {
    const eventSummary = (input.triggering_event.summary as string) ?? "";
    const eventType = (input.triggering_event.type as string) ?? "";
    for (const issue of input.memory.known_issues) {
      // Simple keyword match — extended_pattern would use regex
      const keywords = issue.statement.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = keywords.filter(k => eventSummary.toLowerCase().includes(k) || eventType.includes(k)).length;
      if (matchCount >= 2) return issue.statement;
    }
    return null;
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

      let decision = parsed.decision;
      let reason = parsed.reason ?? "no reason provided";

      // CB1: auto-stop disabled — force "suggest" instead of "stop"
      if (input.circuit_breaker_active && decision === "stop") {
        decision = "suggest";
        reason = `[CB1] Auto-stop disabled. Original: ${reason}`;
      }
      // CB3: warning escalation — upgrade to suggest with escalation note
      if (input.warning_escalation && (decision === "continue" || decision === "collect_more")) {
        decision = "suggest";
        reason = `[CB3] Warning escalation. Original: ${reason}`;
      }

      const result: Decision = {
        decision,
        reason,
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
