import type { ToolSet } from "ai";
import type { Step, Plan } from "@embed-agent/contracts";
import { Agent, type AgentConfig } from "./agent.js";
import type { LLMCallManager } from "./llm.js";

export type { Plan };

export type PlanResult =
  | { status: "planned"; plan: Plan }
  | { status: "clarification_needed"; missing_info: string[]; suggested_next: string };

export const FALLBACK_PLAN: Plan = {
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

interface PlanEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

function parsePlan(content: string): PlanResult {
  try {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
    const parsed = JSON.parse(json) as Record<string, unknown>;

    if (parsed.status === "clarification_needed") {
      return {
        status: "clarification_needed",
        missing_info: (parsed.missing_info as string[]) ?? (parsed.missingInfo as string[]) ?? ["LLM requested clarification"],
        suggested_next: (parsed.suggested_next as string) ?? (parsed.suggestedNext as string) ?? "provide more details",
      };
    }

    const plan = parsed as unknown as Plan;
    if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return { status: "clarification_needed", missing_info: ["plan has no steps"], suggested_next: "provide more details about validation steps" };
    }
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
    return { status: "clarification_needed", missing_info: ["failed to parse plan JSON"], suggested_next: "re-run with clearer task description" };
  }
}

export class Planner {
  private agent: Agent<PlanResult>;
  private eb: PlanEmitter | undefined;

  constructor(llm: LLMCallManager, eb?: PlanEmitter, tools?: ToolSet, maxSteps = 1) {
    const config: AgentConfig<PlanResult> = {
      parse: parsePlan,
      fallback: () => ({ status: "planned", plan: { ...FALLBACK_PLAN, plan_id: generateId() } }),
    };
    if (tools) config.tools = tools;
    if (maxSteps > 1) config.maxSteps = maxSteps;
    this.agent = new Agent("planner", llm, config, eb as unknown as { emit(e: Record<string, unknown>): Promise<void> } | undefined);
    this.eb = eb;
  }

  async call(staticPrompt: string, formattedContext: string, runId?: string): Promise<PlanResult> {
    const result = await this.agent.run(staticPrompt, formattedContext, runId);

    // Planner-specific: emit plan_generated event
    if (result.status === "planned") {
      const plan = result.plan;
      this.eb?.emit({
        type: "plan_generated", run_id: runId, source: "planner",
        summary: `Plan ${plan.plan_id} with ${plan.steps.length} steps`,
        payload: { plan_id: plan.plan_id, step_count: plan.steps.length, source: "llm", estimated_duration_sec: plan.estimated_duration_sec },
      });
    } else {
      this.eb?.emit({
        type: "plan_generated", run_id: runId, source: "planner",
        severity: "warning",
        summary: `Clarification needed: ${result.missing_info.join(", ")}`,
        payload: { status: "clarification_needed", missing_info: result.missing_info },
      });
    }

    return result;
  }
}
