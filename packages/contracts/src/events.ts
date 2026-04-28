import { z } from "zod";
import { RunStateSchema } from "./primitives.js";

export const EventSeveritySchema = z.enum(["debug", "info", "warning", "error"]);
export const EventSourceSchema = z.enum([
  "orchestrator",
  "run_manager",
  "rule_engine",
  "observer",
  "tool_adapter",
  "evidence_store",
  "caller"
]);

export const EventTypeSchema = z.enum([
  "run_created",
  "state_changed",
  "step_started",
  "step_completed",
  "step_failed",
  "step_timeout",
  "rule_matched",
  "target_state_changed",
  "observer_intent",
  "intermediate_observation",
  "evidence_collected",
  "intervention_requested",
  "run_completed",
  "run_failed"
]);

export const RunEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    run_id: z.string().min(1),
    time: z.string().min(1),
    elapsed_sec: z.number().nonnegative(),
    type: EventTypeSchema,
    severity: EventSeveritySchema,
    source: EventSourceSchema,
    step_id: z.string().min(1).optional(),
    summary: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
    evidence_refs: z.array(z.string().min(1)).optional()
  })
  .strict();

export const StateChangedPayloadSchema = z
  .object({
    from: RunStateSchema.nullable(),
    to: RunStateSchema,
    reason: z.string().min(1).optional()
  })
  .strict();

export type EventSeverity = z.infer<typeof EventSeveritySchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type StateChangedPayload = z.infer<typeof StateChangedPayloadSchema>;
