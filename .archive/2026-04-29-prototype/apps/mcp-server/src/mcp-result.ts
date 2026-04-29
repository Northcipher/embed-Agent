import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PublicErrorResponse } from "@artifact-validation/contracts";
import { PublicErrorResponseSchema } from "@artifact-validation/contracts";
import type { RuntimeClientResult } from "./runtime-client.js";

export function toMcpResult(result: RuntimeClientResult<unknown>): CallToolResult {
  if (!result.ok) {
    return jsonToolResult(result.error, true);
  }
  const output = asStructuredObject(result.data);
  return jsonToolResult(output, isPublicError(output));
}

export function jsonToolResult(output: Record<string, unknown>, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify(output, null, 2)
      }
    ],
    structuredContent: output
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function isPublicError(value: unknown): value is PublicErrorResponse {
  return PublicErrorResponseSchema.safeParse(value).success;
}

function asStructuredObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {
    value
  };
}
