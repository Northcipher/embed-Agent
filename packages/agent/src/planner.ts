import type { LLMCallManager, LLMMessage } from "./llm.js";
import type { Step } from "./types.js";

export interface Plan {
  plan_id: string;
  estimated_duration_sec: number;
  steps: Step[];
  evidence_policy: { always: string[]; on_failure: string[] };
  success_criteria: string[];
  failure_signals: string[];
}

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

function generateId(): string { return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

export class Planner {
  constructor(private llm: LLMCallManager) {}

  async call(staticPrompt: string, dynamicContext: PlannerDynamicContext): Promise<PlanResult> {
    const messages: LLMMessage[] = [
      { role: "system", content: staticPrompt },
      { role: "user", content: JSON.stringify(dynamicContext, null, 2) },
    ];

    try {
      const result = await this.llm.call("planner", messages);
      if ("status" in result) {
        // CB4 degraded — use fallback
        return { status: "planned", plan: { ...FALLBACK_PLAN, plan_id: generateId() } };
      }

      return this.parsePlan(result.content);
    } catch {
      // LLM failure — use fallback template
      return { status: "planned", plan: { ...FALLBACK_PLAN, plan_id: generateId() } };
    }
  }

  private parsePlan(content: string): PlanResult {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();

      const parsed = JSON.parse(json) as Plan;

      // Validate required fields
      if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        return { status: "clarification_needed", missing_info: ["plan has no steps"], suggested_next: "provide more details about validation steps" };
      }

      // Validate each step
      for (const s of parsed.steps) {
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
          ...parsed,
          plan_id: parsed.plan_id ?? generateId(),
          evidence_policy: parsed.evidence_policy ?? FALLBACK_PLAN.evidence_policy,
          success_criteria: parsed.success_criteria ?? FALLBACK_PLAN.success_criteria,
          failure_signals: parsed.failure_signals ?? FALLBACK_PLAN.failure_signals,
          estimated_duration_sec: parsed.estimated_duration_sec ?? FALLBACK_PLAN.estimated_duration_sec,
        },
      };
    } catch {
      // JSON parse error from LLM — clarification needed
      return { status: "clarification_needed", missing_info: ["failed to parse plan JSON"], suggested_next: "re-run with clearer task description" };
    }
  }
}
