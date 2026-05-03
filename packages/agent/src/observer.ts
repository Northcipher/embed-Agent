/**
 * Observer v2 — Always LLM, no hard bypasses.
 *
 * Changes from v1:
 *   - Removed matchKnownIssue() hard pre-match (known issues are context hints, not decision substitutes)
 *   - Removed _sev/_type/_cb/_we mutable state (CB handling moved to DecisionHandler post-LLM)
 *   - Primary output path: makeDecision tool (reliable structured output)
 *   - Fallback: parseDecision (text + JSON.parse, retained for degraded scenarios)
 *   - OBSERVER_FALLBACKS simplified: only used when LLM is completely unavailable
 */
import type { Decision } from "./types.js";
import { Agent, type AgentConfig } from "./agent.js";
import type { LLMCallManager } from "./llm.js";
import { makeDecisionTool, type MakeDecisionInput, createObserverTools } from "./output-tools.js";

interface MemoryWriter {
  writeWorkingMemory(runId: string, entry: { key: string; summary: string; source: "observer" | "planner" | "human" }): Promise<void>;
}

// Minimal fallback table — only used when LLM is completely unavailable
const FALLBACK_TABLE: Record<string, Decision["decision"]> = {
  fatal: "stop",
  warning: "collect_more",
  target_state_changed: "pause",
};

function fallbackDecision(severity: string, eventType: string): Decision {
  const action = FALLBACK_TABLE[severity] ?? FALLBACK_TABLE[eventType] ?? "continue";
  return {
    decision: action,
    reason: `Fallback: severity=${severity}, event=${eventType}`,
    confidence: 0.3,
    reasoning_trace: "Observer LLM call failed — using fallback decision",
    evidence_refs: [],
  };
}

/**
 * Parse decision from LLM text output (fallback path only).
 * Called when the makeDecision tool path is unavailable.
 */
function parseDecision(content: string): Decision {
  try {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
    const parsed = JSON.parse(json) as Record<string, unknown>;

    const validDecisions = new Set([
      "stop", "continue", "collect_more", "collect_evidence",
      "extend_wait", "pause", "suggest", "observe_more_frequent", "observe_again_at",
    ]);

    const decision = (parsed.decision as string) ?? "continue";
    if (!validDecisions.has(decision)) {
      return { decision: "continue", reason: "Unrecognized decision type", confidence: 0.3, reasoning_trace: "", evidence_refs: [] };
    }

    const result: Decision = {
      decision: decision as Decision["decision"],
      reason: (parsed.reason as string) ?? "no reason provided",
      confidence: typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence : 0.5,
      reasoning_trace: (parsed.reasoning_trace as string) ?? "",
      evidence_refs: (parsed.evidence_refs as string[]) ?? [],
    };
    if (parsed.params != null) result.params = parsed.params as NonNullable<Decision["params"]>;
    if (parsed.suggestion != null) result.suggestion = parsed.suggestion as string;
    return result;
  } catch {
    return { decision: "continue", reason: "Failed to parse decision output", confidence: 0.3, reasoning_trace: "", evidence_refs: [] };
  }
}

/** Map tool args to Decision type. */
function toolArgsToDecision(args: MakeDecisionInput): Decision {
  const result: Decision = {
    decision: args.decision,
    reason: args.reason,
    confidence: args.confidence,
    reasoning_trace: args.reasoning_trace,
    evidence_refs: args.evidence_refs ?? [],
  };
  if (args.suggestion != null) result.suggestion = args.suggestion;
  if (args.params) {
    const p: NonNullable<Decision["params"]> = {};
    if (args.params.extra_wait_sec != null) p.extra_wait_sec = args.params.extra_wait_sec;
    if (args.params.commands != null) p.logs = args.params.commands;
    if (args.params.timeout_sec != null) p.timeout_sec = args.params.timeout_sec;
    if (args.params.observe_interval != null) p.observe_interval = args.params.observe_interval;
    if (args.params.observe_at != null) p.observe_at = args.params.observe_at;
    if (Object.keys(p).length > 0) result.params = p;
  }
  return result;
}

export class Observer {
  private agent: Agent<Decision>;
  private memory: MemoryWriter | undefined;

  constructor(llm: LLMCallManager, memory?: MemoryWriter, eb?: { emit(e: Record<string, unknown>): Promise<void> }) {
    this.memory = memory;

    const config: AgentConfig<Decision> = {
      parse: parseDecision,
      fallback: (reason: string) => fallbackDecision("warning", "unknown"),
      tools: createObserverTools(),
      outputTool: {
        name: "makeDecision",
        schema: makeDecisionTool.inputSchema,
        handler: (args: Record<string, unknown>) => toolArgsToDecision(args as MakeDecisionInput),
      },
      stepCount: 2,
      textFallbackPrefix: [
        "You are an Embed Agent Observer. Decide what action to take based on the evidence.",
        "Output ONLY a JSON decision — no explanation, no markdown outside the JSON.",
        'Available decisions: continue, stop, collect_more, collect_evidence, extend_wait, pause, suggest, observe_more_frequent, observe_again_at',
        'Output: {"decision":"<choice>","reason":"<1 sentence>","confidence":0.0-1.0,"reasoning_trace":"<detailed analysis>","evidence_refs":["<refs>"]}',
      ].join("\n"),
    };

    this.agent = new Agent("observer", llm, config, eb);
  }

  /**
   * Decide — always via LLM. No hard bypasses.
   *
   * CB1/CB3 downgrade is handled by DecisionHandler AFTER this method returns.
   * Known issues are injected into context by ContextAssembler, not pre-matched here.
   */
  async decide(
    staticPrompt: string,
    formattedContext: string,
    runId?: string,
  ): Promise<Decision> {
    const decision = await this.agent.run(staticPrompt, formattedContext, runId);

    // Write working memory entry (best-effort)
    if (runId) {
      this.memory?.writeWorkingMemory(runId, {
        key: `observer_decision_${Date.now()}`,
        summary: `[${decision.decision}] ${decision.reason}`,
        source: "observer",
      }).catch(() => {});
    }

    return decision;
  }
}
