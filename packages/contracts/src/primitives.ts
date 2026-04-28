import { z } from "zod";

export const IdSchema = z.string().min(1);
export const IsoTimeSchema = z.string().min(1);
export const PathSchema = z.string().min(1);
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const RunStateSchema = z.enum([
  "queued",
  "planning",
  "running",
  "collecting_evidence",
  "completed",
  "failed",
  "paused",
  "cancelled"
]);

export const TerminalRunStateSchema = z.enum(["completed", "failed", "cancelled"]);

export const PublicErrorCodeSchema = z.enum([
  "invalid_request",
  "target_not_found",
  "target_busy",
  "run_not_found",
  "artifact_invalid",
  "plan_rejected",
  "unsupported_action"
]);

export const PublicErrorResponseSchema = z
  .object({
    status: z.literal("error"),
    error_code: PublicErrorCodeSchema,
    message: z.string().min(1)
  })
  .strict();

export type RunState = z.infer<typeof RunStateSchema>;
export type TerminalRunState = z.infer<typeof TerminalRunStateSchema>;
export type PublicErrorCode = z.infer<typeof PublicErrorCodeSchema>;
export type PublicErrorResponse = z.infer<typeof PublicErrorResponseSchema>;
