import type { Decision } from "./types.js";
import { Agent, type AgentConfig } from "./agent.js";
import type { LLMCallManager } from "./llm.js";

interface MemoryWriter {
  writeWorkingMemory(runId: string, entry: { key: string; summary: string; source: "observer" | "planner" | "human" }): Promise<void>;
}

const OBSERVER_FALLBACKS: Record<string, Decision["decision"]> = {
  fatal: "stop",
  target_state_changed: "pause",
};

function fallbackDecision(severity: string, eventType: string): Decision {
  const action = OBSERVER_FALLBACKS[severity] ?? OBSERVER_FALLBACKS[eventType] ?? "continue";
  return {
    decision: action,
    reason: `Fallback: severity=${severity}, event=${eventType}`,
    confidence: 0.3,
    reasoning_trace: "Observer LLM call failed — using fallback decision",
    evidence_refs: [],
  };
}

function parseDecision(content: string, severity: string, eventType: string, cbActive: boolean, warnEsc: boolean): Decision {
  try {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
    const parsed = JSON.parse(json) as Decision;

    const validDecisions = ["stop", "continue", "collect_more", "extend_wait", "pause", "suggest", "observe_more_frequent", "observe_again_at"];
    if (!validDecisions.includes(parsed.decision)) {
      return fallbackDecision(severity, eventType);
    }
    if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
      parsed.confidence = 0.5;
    }

    let decision = parsed.decision;
    let reason = parsed.reason ?? "no reason provided";

    if (cbActive && decision === "stop") {
      decision = "suggest";
      reason = `[CB1] Auto-stop disabled. Original: ${reason}`;
    }
    if (warnEsc && (decision === "continue" || decision === "collect_more")) {
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
    return fallbackDecision(severity, eventType);
  }
}

export class Observer {
  private agent: Agent<Decision>;
  private memory: MemoryWriter | undefined;
  // Per-call params for parse/fallback closures
  private _sev = "info";
  private _type = "unknown";
  private _cb = false;
  private _we = false;

  constructor(llm: LLMCallManager, memory?: MemoryWriter, eb?: { emit(e: Record<string, unknown>): Promise<void> }) {
    this.memory = memory;
    const config: AgentConfig<Decision> = {
      parse: (content: string) => parseDecision(content, this._sev, this._type, this._cb, this._we),
      fallback: () => fallbackDecision(this._sev, this._type),
    };
    this.agent = new Agent("observer", llm, config, eb);
  }

  async decide(
    staticPrompt: string,
    formattedContext: string,
    runId?: string,
    triggerSummary?: string,
    triggerType?: string,
    triggerSeverity?: string,
    cbActive?: boolean,
    warnEsc?: boolean,
    knownIssues?: { fact_id: string; category: string; statement: string; extended_pattern?: string }[],
  ): Promise<Decision> {
    // Pre-LLM: known issue matching
    if (triggerSummary) {
      const knownMatch = this.matchKnownIssue(triggerSummary, triggerType ?? "", knownIssues ?? []);
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
    }

    // Store per-call params (used by parse/fallback closures in AgentConfig)
    this._sev = triggerSeverity ?? "info";
    this._type = triggerType ?? "unknown";
    this._cb = cbActive ?? false;
    this._we = warnEsc ?? false;

    const decision = await this.agent.run(staticPrompt, formattedContext, runId);

    if (runId) {
      this.memory?.writeWorkingMemory(runId, {
        key: `observer_decision_${Date.now()}`,
        summary: `[${decision.decision}] ${decision.reason}`,
        source: "observer",
      }).catch(() => {});
    }

    return decision;
  }

  private matchKnownIssue(
    eventSummary: string,
    eventType: string,
    knownIssues: { fact_id: string; category: string; statement: string; extended_pattern?: string }[],
  ): string | null {
    const safeSummary = eventSummary.length > 1000 ? eventSummary.slice(0, 1000) : eventSummary;
    for (const issue of knownIssues) {
      if (issue.extended_pattern) {
        try {
          const re = new RegExp(issue.extended_pattern);
          if (/(\*|\+|\{)\s*(\*|\+|\{)/.test(issue.extended_pattern)) continue;
          if (re.test(safeSummary)) return issue.statement;
        } catch {}
      }
      const keywords = issue.statement.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = keywords.filter(k => safeSummary.toLowerCase().includes(k) || eventType.includes(k)).length;
      if (matchCount >= 3) return issue.statement;
    }
    return null;
  }
}
