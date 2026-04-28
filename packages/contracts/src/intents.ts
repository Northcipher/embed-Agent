import { z } from "zod";
import { RequestedActionSchema } from "./capabilities.js";

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
