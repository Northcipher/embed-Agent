/**
 * Output Tools — structured tool schemas for LLM-generated outputs.
 *
 * Each role (Planner, Observer, Reply) has a dedicated "submit" tool.
 * Using tool calling for structured output is more reliable than JSON.parse:
 * the model provider guarantees the tool_use block structure, avoiding
 * regex extraction and brittle parsing.
 *
 * All tools follow the AI SDK tool format with Zod v4 schemas.
 */
import { z } from "zod/v4";
import type { ToolSet } from "ai";

// ============================================================
// submitPlan — Planner output
// ============================================================

export const SubmitPlanSchema = z.object({
  plan_id: z.string().describe("Unique plan identifier"),
  estimated_duration_sec: z.number().describe("Estimated total duration in seconds"),
  steps: z.array(z.object({
    id: z.string(),
    action: z.enum(["exec", "stream", "push", "flash", "wait"]),
    capability: z.string(),
    command: z.string().optional(),
    timeout_sec: z.number(),
    condition: z.enum(["always", "on_failure", "on_success"]).optional(),
    on_failure: z.enum(["stop", "continue", "collect_and_stop"]).optional(),
    src: z.string().optional(),
    dst: z.string().optional(),
    image: z.string().optional(),
    partition: z.string().optional(),
    observe: z.object({ interval: z.number(), metrics: z.array(z.string()), trend_window: z.number(), sampling_commands: z.array(z.string()) }).optional(),
    retry_policy: z.object({ max_retries: z.number(), intervals_sec: z.array(z.number()) }).optional(),
  })),
  evidence_policy: z.object({
    always: z.array(z.string()),
    on_failure: z.array(z.string()),
  }),
  success_criteria: z.array(z.string()),
  failure_signals: z.array(z.string()),
});

export const submitPlanTool = {
  description: "Submit the validation plan. Call this ONCE when you have explored the device state, capabilities, and relevant patterns and are ready to commit to a step-by-step plan.",
  inputSchema: SubmitPlanSchema,
};

export type SubmitPlanInput = z.infer<typeof SubmitPlanSchema>;

// ============================================================
// makeDecision — Observer output
// ============================================================

export const MakeDecisionSchema = z.object({
  decision: z.enum([
    "stop",
    "continue",
    "collect_more",
    "collect_evidence",
    "extend_wait",
    "pause",
    "suggest",
    "observe_more_frequent",
    "observe_again_at",
  ]).describe("The decision to execute"),
  reason: z.string().describe("Concise reason for this decision (1 sentence)"),
  confidence: z.number().min(0).max(1).describe("Confidence in this decision (0.0–1.0)"),
  reasoning_trace: z.string().describe("Detailed reasoning chain leading to this decision"),
  evidence_refs: z.array(z.string()).optional().describe("Evidence references supporting this decision"),
  params: z.object({
    extra_wait_sec: z.number().optional().describe("Seconds to extend wait for 'extend_wait'"),
    commands: z.array(z.string()).optional().describe("Diagnostic commands to run for 'collect_evidence'"),
    timeout_sec: z.number().optional().describe("Timeout for additional collection"),
    observe_interval: z.number().optional().describe("New observation interval for 'observe_more_frequent'"),
    observe_at: z.number().optional().describe("Timestamp to re-check for 'observe_again_at'"),
  }).optional(),
  suggestion: z.string().optional().describe("Human-readable suggestion for 'suggest' decisions"),
});

export const makeDecisionTool = {
  description: "Submit an observation decision. Call this ONCE per triggering event. Choose the action that best reflects the evidence: continue if benign, collect_more/collect_evidence if uncertain, stop if this clearly indicates failure.",
  inputSchema: MakeDecisionSchema,
};

export type MakeDecisionInput = z.infer<typeof MakeDecisionSchema>;

// ============================================================
// submitCriterionResult — Reply per-criterion output
// ============================================================

export const SubmitCriterionResultSchema = z.object({
  criterion: z.string().describe("The exact success criterion being evaluated"),
  status: z.enum(["pass", "fail", "unknown"]).describe("Evaluation verdict"),
  confidence: z.number().min(0).max(1).describe("Confidence in this evaluation"),
  reasoning: z.string().describe("Detailed reasoning for the verdict"),
  evidence_refs: z.array(z.string()).describe("Evidence references supporting this evaluation"),
});

export const submitCriterionResultTool = {
  description: "Submit evaluation for ONE success criterion. Call once per criterion with focused analysis of relevant evidence.",
  inputSchema: SubmitCriterionResultSchema,
};

export type SubmitCriterionResultInput = z.infer<typeof SubmitCriterionResultSchema>;

// ============================================================
// submitReply — Reply synthesis output
// ============================================================

export const SubmitReplySchema = z.object({
  summary: z.string().describe("2-4 sentence summary: what was expected, what happened, key findings"),
  suggested_next: z.string().describe("Concrete next action to take"),
  key_evidence: z.array(z.object({
    summary: z.string(),
    evidence_refs: z.array(z.string()),
  })).describe("Key evidence items with references"),
  criteria_results: z.array(z.object({
    criterion: z.string(),
    status: z.enum(["pass", "fail", "unknown"]),
    evidence_refs: z.array(z.string()),
  })).optional().describe("Per-criterion evaluation results"),
  confidence: z.number().min(0).max(1).describe("Overall confidence in this reply"),
});

export const submitReplyTool = {
  description: "Submit the final reply. Call ONCE after evaluating all criteria. The run status is PRE-DETERMINED by the system — you output only the narrative.",
  inputSchema: SubmitReplySchema,
};

export type SubmitReplyInput = z.infer<typeof SubmitReplySchema>;

// ============================================================
// Tool sets per role — can be merged with exploration tools
// ============================================================

/** Observer tools: only the decision output tool. */
export function createObserverTools(): ToolSet {
  return { makeDecision: makeDecisionTool } as unknown as ToolSet;
}
