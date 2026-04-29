export const ERROR_CODES = [
  "invalid_request",
  "target_not_found",
  "target_busy",
  "target_not_ready",
  "run_not_found",
  "artifact_invalid",
  "plan_rejected",
  "clarification_needed",
  "unsupported_action",
  "internal_error",
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export interface ErrorResponse {
  status: "error";
  error_code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
