/**
 * Planner v2 — exploration-first plan generation with tool-calling output.
 *
 * Primary path: model explores device state, capabilities, and skill patterns
 *   using injected tools, then submits the plan via the submitPlan tool.
 * Fallback: text output parsed via parsePlan (retained for degraded scenarios).
 */
import type { ToolSet } from "ai";
import type { Step, Plan } from "@embed-agent/contracts";
import { Agent, type AgentConfig, type AgentFallbackInput } from "./agent.js";
import type { LLMCallManager } from "./llm.js";
import { submitPlanTool, type SubmitPlanInput } from "./output-tools.js";

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

function contextHas(formattedContext: string, pattern: RegExp): boolean {
  return pattern.test(formattedContext);
}

function maxDurationFromContext(formattedContext: string): number | undefined {
  const match = formattedContext.match(/max_duration_sec:\s*(\d+)s?/i);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function serialFallbackPlan(input: AgentFallbackInput): Plan {
  const maxDuration = maxDurationFromContext(input.formattedContext);
  const streamTimeout = Math.max(10, Math.min(maxDuration ?? 60, 60));
  return {
    plan_id: generateId(),
    estimated_duration_sec: streamTimeout,
    steps: [
      {
        id: "fb_serial_stream",
        capability: "serial_output",
        action: "stream",
        timeout_sec: streamTimeout,
        on_failure: "stop",
      },
    ],
    evidence_policy: {
      always: ["serial:full", "events"],
      on_failure: ["serial:last-window", "events"],
    },
    success_criteria: [
      "serial port opens successfully",
      "serial stream is readable or the run reaches the requested observation timeout without transport errors",
    ],
    failure_signals: [
      "serial port cannot be opened",
      "permission denied",
      "device disconnected",
      "kernel panic",
      "fatal error",
    ],
  };
}

function fallbackPlanForContext(input: AgentFallbackInput): PlanResult {
  const ctx = input.formattedContext;
  const hasSerial = contextHas(ctx, /serial\s*:\s*\[object Object\]|serial\s*:/i);
  const hasAdb = contextHas(ctx, /adb\s*:\s*\[object Object\]|adb\s*:/i);
  const hasFastboot = contextHas(ctx, /fastboot\s*:\s*\[object Object\]|fastboot\s*:/i);
  const forbidsFlash = contextHas(ctx, /no_flash:\s*true|allow_flash:\s*false/i);
  const forbidsShell = contextHas(ctx, /allow_shell_exec:\s*false/i);
  const serialTask = contextHas(ctx, /serial|串口|usbmodem|uart/i);

  if (hasSerial && (serialTask || (forbidsFlash && forbidsShell) || (!hasAdb && !hasFastboot))) {
    return { status: "planned", plan: serialFallbackPlan(input) };
  }

  return { status: "planned", plan: { ...FALLBACK_PLAN, plan_id: generateId() } };
}

interface PlanEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

// ============================================================
// Fallback: parse plan from text (used when tool path unavailable)
// ============================================================

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

    // Handle common LLM wrappers: {"plan": {...}} or top-level plan
    const planData = (parsed.plan as Record<string, unknown>) ?? parsed;
    const plan = planData as unknown as Plan;
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

// ============================================================
// Tool handler: submitPlan args → PlanResult
// ============================================================

function toolArgsToPlan(args: SubmitPlanInput): PlanResult {
  const plan: Plan = {
    plan_id: args.plan_id,
    estimated_duration_sec: args.estimated_duration_sec,
    steps: args.steps.map(s => {
      const step: Step = {
        id: s.id,
        action: s.action,
        capability: s.capability,
        timeout_sec: s.timeout_sec,
      };
      if (s.command != null) step.command = s.command;
      if (s.condition != null) step.condition = s.condition;
      if (s.on_failure != null) step.on_failure = s.on_failure;
      if (s.observe != null) step.observe = s.observe as any;
      if (s.retry_policy != null) step.retry_policy = s.retry_policy as any;
      if (s.src != null) step.src = s.src;
      if (s.dst != null) step.dst = s.dst;
      return step;
    }),
    evidence_policy: args.evidence_policy,
    success_criteria: args.success_criteria,
    failure_signals: args.failure_signals,
  };
  return { status: "planned", plan };
}

// ============================================================
// Planner
// ============================================================

export class Planner {
  private agent: Agent<PlanResult>;
  private eb: PlanEmitter | undefined;

  constructor(llm: LLMCallManager, eb?: PlanEmitter, tools?: ToolSet, stepCount = 8) {
    const config: AgentConfig<PlanResult> = {
      parse: parsePlan,
      fallback: (_reason: string, input: AgentFallbackInput) => fallbackPlanForContext(input),
      outputTool: {
        name: "submitPlan",
        schema: submitPlanTool.inputSchema,
        handler: (args: Record<string, unknown>) => toolArgsToPlan(args as SubmitPlanInput),
      },
      stepCount,
      textFallbackPrefix: [
        "You are an Embed Agent Task Planner in text-only mode (no tools available).",
        "Create a concrete validation plan for an embedded device. Output ONLY a JSON plan — no explanation, no natural language, no markdown outside the JSON.",
        "",
        "## Valid Capability × Action combinations:",
        "- serial_output → stream (serial console output)",
        "- shell_exec → exec (device shell via ADB)",
        "- adb_logs → stream or exec (logcat -d dump)",
        "- wait_adb → wait (wait for device ready)",
        "- flash → flash (format: image_path:partition)",
        "- push → push (format: src:dst)",
        "- collect_logs → exec (dmesg, logcat)",
        "- local_exec → exec (host machine command)",
        "- ssh_exec → exec (device shell via SSH)",
        "",
        "## Typical execution order:",
        "1. stream serial_output (observe boot, 60-180s timeout)",
        "2. wait_adb (wait for device, 30-120s timeout)",
        "3. shell_exec (verify with commands, 15-30s timeout)",
        "4. collect_logs (collect dmesg/logcat, 15-60s timeout)",
        "",
        "## Output format (inside ```json code block):",
        "{",
        '  "plan_id": "<unique-id>",',
        '  "estimated_duration_sec": <number>,',
        '  "steps": [',
        '    {"id": "<kebab>", "action": "<from-above>", "capability": "<from-above>", "command": "<only for exec/flash/push>", "timeout_sec": <number>}',
        "  ],",
        '  "evidence_policy": {"always": ["serial:full", "dmesg"], "on_failure": ["serial:last-window", "logcat"]},',
        '  "success_criteria": ["<concrete>"],',
        '  "failure_signals": ["<concrete>"]',
        "}",
        "",
        "NOW OUTPUT THE PLAN:",
      ].join("\n"),
    };
    if (tools) config.tools = tools;
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
