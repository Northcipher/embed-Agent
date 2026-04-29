import { z } from "zod";
import { RequestedActionSchema } from "./capabilities.js";
import { PlanSchema } from "./plan.js";

export const MatchedScenarioSchema = z
  .object({
    name: z.string().min(1),
    reason: z.string().min(1)
  })
  .strict();

export const InferredValueSchema = z
  .object({
    value: z.unknown(),
    source: z.string().min(1).optional(),
    recommend_confirm: z.boolean().optional()
  })
  .strict();

export const ValidationIntentSchema = z
  .object({
    intent_id: z.string().min(1),
    feature_area: z.string().min(1),
    summary: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1),
    confidence_reason: z.string().min(1).optional(),
    matched_scenarios: z.array(MatchedScenarioSchema),
    expected_behavior: z.array(z.string().min(1)),
    risk_focus: z.array(z.string().min(1)),
    suggested_actions: z.array(z.string().min(1)),
    observe: z.array(z.string().min(1)),
    evidence_need: z.array(z.string().min(1)),
    pass_fail: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
    missing_info: z.array(z.string().min(1)),
    inferred_values: z.record(z.string(), InferredValueSchema).optional()
  })
  .strict();

export const TaskPlannerPlannedOutputSchema = z
  .object({
    status: z.literal("planned"),
    validation_intent: ValidationIntentSchema,
    plan: PlanSchema,
    missing_info: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1))
  })
  .strict();

export const TaskPlannerClarificationOutputSchema = z
  .object({
    status: z.literal("clarification_needed"),
    reason: z.string().min(1),
    missing_info: z.array(z.string().min(1)).min(1),
    suggested_next: z.string().min(1),
    assumptions: z.array(z.string().min(1)).optional()
  })
  .strict();

export const TaskPlannerOutputSchema = z.discriminatedUnion("status", [
  TaskPlannerPlannedOutputSchema,
  TaskPlannerClarificationOutputSchema
]);

export const ObserverIntentNameSchema = z.enum([
  "continue",
  "extend_wait",
  "collect_more",
  "pause",
  "stop",
  "intermediate_observation"
]);

export const StopResultStatusSchema = z.enum(["completed", "failed", "timeout"]);

export const ObserverIntentSchema = z
  .object({
    intent: ObserverIntentNameSchema,
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
    params: z.record(z.string(), z.unknown()).optional(),
    requested_actions: z.array(RequestedActionSchema),
    report_to_caller: z.boolean()
  })
  .strict();

export type ObserverIntentName = z.infer<typeof ObserverIntentNameSchema>;
export type StopResultStatus = z.infer<typeof StopResultStatusSchema>;
export type ObserverIntent = z.infer<typeof ObserverIntentSchema>;
export type MatchedScenario = z.infer<typeof MatchedScenarioSchema>;
export type InferredValue = z.infer<typeof InferredValueSchema>;
export type ValidationIntent = z.infer<typeof ValidationIntentSchema>;
export type TaskPlannerPlannedOutput = z.infer<typeof TaskPlannerPlannedOutputSchema>;
export type TaskPlannerClarificationOutput = z.infer<typeof TaskPlannerClarificationOutputSchema>;
export type TaskPlannerOutput = z.infer<typeof TaskPlannerOutputSchema>;
