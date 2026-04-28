import type { AgentReply, CapabilityName, ObserverIntent, TaskPlannerOutput } from "@artifact-validation/contracts";
import { AgentReplySchema, ObserverIntentSchema, TaskPlannerOutputSchema } from "@artifact-validation/contracts";
import type { ValidationResult } from "./types.js";

export type TaskPlannerValidationContext = {
  availableCapabilities: CapabilityName[];
  hasTestHint: boolean;
};

export type ObserverValidationContext = {
  allowedFollowUpCapabilities: CapabilityName[];
  remainingDurationSec: number;
};

export type ReplyValidationContext = {
  runId: string;
  finalStatus: AgentReply["status"];
  evidenceRefs: string[];
};

export function validateTaskPlannerOutput(
  value: Record<string, unknown>,
  context: TaskPlannerValidationContext
): ValidationResult<TaskPlannerOutput> {
  const parsed = TaskPlannerOutputSchema.safeParse(value);
  if (!parsed.success) {
    return invalid("plan_rejected", parsed.error.message);
  }
  if (parsed.data.status === "clarification_needed") {
    return { status: "valid", value: parsed.data };
  }
  if (parsed.data.missing_info.length > 0) {
    return invalid("clarification_needed", "planned output cannot contain missing_info");
  }
  for (const step of parsed.data.plan.steps) {
    if (!context.availableCapabilities.includes(step.capability)) {
      return invalid("plan_rejected", `unknown or unavailable capability ${step.capability}`);
    }
    if (containsConnectionParameter(step.input)) {
      return invalid("plan_rejected", `step ${step.id} contains connection parameters`);
    }
    if (!context.hasTestHint && step.capability === "shell_exec" && typeof step.input.command === "string") {
      return invalid("clarification_needed", "planner cannot invent shell_exec command without test_hint");
    }
  }
  return { status: "valid", value: parsed.data };
}

export function validateObserverIntent(
  value: Record<string, unknown>,
  context: ObserverValidationContext
): ValidationResult<ObserverIntent> {
  const parsed = ObserverIntentSchema.safeParse(value);
  if (!parsed.success) {
    return invalid("observer_intent_rejected", parsed.error.message);
  }
  if (parsed.data.intent === "intermediate_observation" && parsed.data.requested_actions.length > 0) {
    return invalid("observer_intent_rejected", "intermediate_observation cannot request actions");
  }
  if (parsed.data.intent === "extend_wait" && context.remainingDurationSec <= 0) {
    return invalid("observer_intent_rejected", "extend_wait has no remaining time budget");
  }
  for (const action of parsed.data.requested_actions) {
    if (!context.allowedFollowUpCapabilities.includes(action.capability)) {
      return invalid("observer_intent_rejected", `unsupported requested action ${action.capability}`);
    }
    if (parsed.data.intent === "collect_more" && action.capability !== "collect_logs" && action.capability !== "save_snapshot") {
      return invalid("observer_intent_rejected", `collect_more cannot request ${action.capability}`);
    }
  }
  return { status: "valid", value: parsed.data };
}

export function validateAgentReply(value: Record<string, unknown>, context: ReplyValidationContext): ValidationResult<AgentReply> {
  const parsed = AgentReplySchema.safeParse(value);
  if (!parsed.success) {
    return invalid("reply_rejected", parsed.error.message);
  }
  if (parsed.data.run_id !== context.runId) {
    return invalid("reply_rejected", "reply run_id does not match current run");
  }
  if (parsed.data.status !== context.finalStatus) {
    return invalid("reply_rejected", "reply status conflicts with final run state");
  }
  const evidenceRefs = new Set(context.evidenceRefs);
  for (const item of parsed.data.key_evidence) {
    for (const ref of item.evidence_refs) {
      if (!evidenceRefs.has(ref)) {
        return invalid("reply_rejected", `reply references missing evidence_ref ${ref}`);
      }
    }
  }
  if (/\b(diff|patch|apply_patch|git apply)\b/i.test(parsed.data.summary) || /\b(diff|patch|apply_patch|git apply)\b/i.test(parsed.data.suggested_next ?? "")) {
    return invalid("reply_rejected", "reply must not output patch instructions");
  }
  return { status: "valid", value: parsed.data };
}

export function createRuleBasedReply(input: {
  runId: string;
  status: AgentReply["status"];
  evidencePath: string;
  summary?: string;
}): AgentReply {
  return {
    run_id: input.runId,
    status: input.status,
    summary: input.summary ?? `run ${input.status}; review events and evidence refs`,
    confidence: 0.5,
    key_evidence: [],
    suggested_next: "review evidence refs and rerun with more context if needed",
    evidence_path: input.evidencePath
  };
}

type FailureStatus = "plan_rejected" | "clarification_needed" | "observer_intent_rejected" | "reply_rejected";

function invalid(failureStatus: FailureStatus, reason: string): ValidationResult<never> {
  return {
    status: "invalid",
    failure_status: failureStatus,
    reason
  };
}

function containsConnectionParameter(input: Record<string, unknown>): boolean {
  const forbiddenKeys = new Set(["serial_port", "port", "baud", "device_id", "adb_device_id", "fastboot_id", "connection"]);
  return Object.keys(input).some(key => forbiddenKeys.has(key));
}
