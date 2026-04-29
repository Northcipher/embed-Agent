import type { PublicErrorCode, PublicErrorResponse } from "@artifact-validation/contracts";

export class RuntimeHttpError extends Error {
  readonly statusCode: number;

  readonly response: PublicErrorResponse;

  constructor(statusCode: number, errorCode: PublicErrorCode, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.response = {
      status: "error",
      error_code: errorCode,
      message
    };
  }
}

export function invalidRequest(message: string): RuntimeHttpError {
  return new RuntimeHttpError(400, "invalid_request", message);
}

export function runNotFound(runId: string): RuntimeHttpError {
  return new RuntimeHttpError(404, "run_not_found", `run ${runId} was not found`);
}

export function resourceNotFound(message: string): RuntimeHttpError {
  return new RuntimeHttpError(404, "resource_not_found", message);
}

export function unsupportedAction(message: string): RuntimeHttpError {
  return new RuntimeHttpError(409, "unsupported_action", message);
}
