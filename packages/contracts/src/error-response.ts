import type { ErrorCode } from "./error.js";

export interface ErrorResponse {
  status: "error";
  error_code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function makeError(code: ErrorCode, message: string, details?: Record<string, unknown>): ErrorResponse {
  const resp = { status: "error" as const, error_code: code, message, details: details as Record<string, unknown> | undefined } as ErrorResponse;
  return resp;
}
