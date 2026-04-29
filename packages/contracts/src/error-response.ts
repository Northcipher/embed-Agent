import type { ErrorCode } from "./error.js";

export interface ErrorResponse {
  status: "error";
  error_code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function makeError(code: ErrorCode, message: string, details?: Record<string, unknown>): ErrorResponse {
  const resp: ErrorResponse = { status: "error", error_code: code, message };
  if (details !== undefined) (resp as Record<string, unknown>).details = details;
  return resp;
}
