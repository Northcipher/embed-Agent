import { z } from "zod";
import { CapabilityNameSchema } from "./capabilities.js";
import { IdSchema } from "./primitives.js";

export const PlanStepConditionSchema = z.enum(["always", "on_failure", "on_success"]);
export const PlanStepFailurePolicySchema = z.enum(["collect_and_fail", "continue", "fail"]);

export const PlanStepSchema = z
  .object({
    id: IdSchema,
    capability: CapabilityNameSchema,
    condition: PlanStepConditionSchema,
    input: z.record(z.string(), z.unknown()),
    timeout_sec: z.number().int().positive(),
    on_failure: PlanStepFailurePolicySchema.optional()
  })
  .strict();

export const EvidencePolicySchema = z
  .object({
    always: z.array(z.string().min(1)),
    on_failure: z.array(z.string().min(1)).optional(),
    on_success: z.array(z.string().min(1)).optional()
  })
  .strict();

export const PlanSchema = z
  .object({
    plan_id: IdSchema,
    intent_ref: IdSchema.optional(),
    estimated_duration_sec: z.number().int().positive(),
    steps: z.array(PlanStepSchema).min(1),
    success_criteria: z.array(z.string().min(1)).min(1),
    failure_signals: z.array(z.string().min(1)),
    evidence_policy: EvidencePolicySchema
  })
  .strict();

export type PlanStepCondition = z.infer<typeof PlanStepConditionSchema>;
export type PlanStepFailurePolicy = z.infer<typeof PlanStepFailurePolicySchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>;
export type Plan = z.infer<typeof PlanSchema>;
