import type { LLMCallManager, LLMMessage } from "./llm.js";
import type { Step, Plan } from "@embed-agent/contracts";

export type { Plan };

export interface PlannerDynamicContext {
  target_id: string;
  task: string;
  expected: string;
  concerns?: string[];
  target_hints: Record<string, unknown>;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  recent_episodes: { episode_id: string; summary: string; result: string }[];
  relevant_facts: { fact_id: string; category: string; statement: string }[];
  pitfalls: string[];
  constraints?: { max_duration_sec?: number; allow_flash?: boolean; allow_shell_exec?: boolean };
  matched_skills?: { name: string; description: string }[];
}

export type PlanResult =
  | { status: "planned"; plan: Plan }
  | { status: "clarification_needed"; missing_info: string[]; suggested_next: string };

const FALLBACK_PLAN: Plan = {
  plan_id: "fallback",
  estimated_duration_sec: 600,
  steps: [
    { id: "fb_flash", capability: "flash", action: "flash", command: "image:boot", timeout_sec: 300 },
    { id: "fb_stream", capability: "serial_output", action: "stream", timeout_sec: 180 },
    { id: "fb_wait_adb", capability: "wait_adb", action: "wait", command: "wait_adb", timeout_sec: 180 },
    { id: "fb_check", capability: "shell_exec", action: "exec", command: "uname -a", timeout_sec: 60 },
    { id: "fb_dmesg", capability: "collect_logs", action: "exec", command: "dmesg", timeout_sec: 120 },
  ],
  evidence_policy: { always: ["serial:full", "dmesg"], on_failure: ["serial:last-window", "logcat"] },
  success_criteria: ["device boots", "basic shell works"],
  failure_signals: ["kernel panic", "boot loop", "adb offline"],
};

interface PlanEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

function generateId(): string { return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

export class Planner {
  private eb: PlanEmitter | undefined;

  constructor(private llm: LLMCallManager, eb?: PlanEmitter) {
    this.eb = eb;
  }

  async call(staticPrompt: string, dynamicContext: PlannerDynamicContext): Promise<PlanResult> {
    const messages: LLMMessage[] = [
      { role: "system", content: staticPrompt },
      { role: "user", content: JSON.stringify(dynamicContext, null, 2) },
    ];

    let result: PlanResult;

    try {
      const llmResult = await this.llm.call("planner", messages);
      if ("status" in llmResult) {
        // CB4 degraded — use fallback
        result = { status: "planned", plan: { ...FALLBACK_PLAN, plan_id: generateId() } };
        this.eb?.emit({ type: "plan_generation_failed", source: "planner", summary: "CB4 degraded — used fallback plan", payload: {} });
        return result;
      }

      result = this.parsePlan(llmResult.content);
    } catch {
      // LLM failure — use fallback template
      result = { status: "planned", plan: { ...FALLBACK_PLAN, plan_id: generateId() } };
      this.eb?.emit({ type: "plan_generation_failed", source: "planner", summary: "LLM call failed — used fallback plan", payload: {} });
      return result;
    }

    // Emit audit event
    if (result.status === "planned") {
      this.eb?.emit({
        type: "plan_generated", source: "planner",
        summary: `Plan ${result.plan.plan_id} generated with ${result.plan.steps.length} steps`,
        payload: { plan_id: result.plan.plan_id, step_count: result.plan.steps.length, estimated_duration_sec: result.plan.estimated_duration_sec },
      });
    } else {
      this.eb?.emit({
        type: "plan_generation_failed", source: "planner",
        summary: `Clarification needed: ${result.missing_info.join(", ")}`,
        payload: { missing_info: result.missing_info },
      });
    }

    return result;
  }

  private parsePlan(content: string): PlanResult {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();

      const parsed = JSON.parse(json) as Record<string, unknown>;

      // Detect clarification_needed response from LLM
      if (parsed.status === "clarification_needed") {
        return {
          status: "clarification_needed",
          missing_info: (parsed.missing_info as string[]) ?? (parsed.missingInfo as string[]) ?? ["LLM requested clarification"],
          suggested_next: (parsed.suggested_next as string) ?? (parsed.suggestedNext as string) ?? "provide more details",
        };
      }

      const plan = parsed as unknown as Plan;

      // Validate required fields
      if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        return { status: "clarification_needed", missing_info: ["plan has no steps"], suggested_next: "provide more details about validation steps" };
      }

      // Validate each step
      for (const s of plan.steps) {
        if (!s.id || !s.action || !s.capability || !s.timeout_sec) {
          return { status: "clarification_needed", missing_info: [`step missing required fields: ${JSON.stringify(s)}`], suggested_next: "specify id, action, capability, and timeout_sec for each step" };
        }
        if (!["exec", "stream", "push", "flash", "wait"].includes(s.action)) {
          return { status: "clarification_needed", missing_info: [`invalid action "${s.action}" in step ${s.id}`], suggested_next: "use valid actions: exec, stream, push, flash, wait" };
        }
        if (s.timeout_sec > 3600) {
          return { status: "clarification_needed", missing_info: [`step ${s.id} timeout exceeds 1 hour`], suggested_next: "reduce step timeout" };
        }
      }

      return {
        status: "planned",
        plan: {
          ...plan,
          plan_id: plan.plan_id ?? generateId(),
          evidence_policy: plan.evidence_policy ?? FALLBACK_PLAN.evidence_policy,
          success_criteria: plan.success_criteria ?? FALLBACK_PLAN.success_criteria,
          failure_signals: plan.failure_signals ?? FALLBACK_PLAN.failure_signals,
          estimated_duration_sec: plan.estimated_duration_sec ?? FALLBACK_PLAN.estimated_duration_sec,
        },
      };
    } catch {
      // JSON parse error from LLM — clarification needed
      return { status: "clarification_needed", missing_info: ["failed to parse plan JSON"], suggested_next: "re-run with clearer task description" };
    }
  }
}
