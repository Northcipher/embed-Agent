import type { ParseResult } from "./types.js";

export function parseSingleJsonObject(rawText: string): ParseResult {
  const first = findJsonObjectRange(rawText, 0);
  if (first === undefined) {
    return { status: "parse_failed", error: "no JSON object found" };
  }
  const second = findJsonObjectRange(rawText, first.end);
  if (second !== undefined) {
    return { status: "parse_failed", error: "multiple JSON objects found" };
  }

  try {
    const value = JSON.parse(rawText.slice(first.start, first.end)) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { status: "parse_failed", error: "top-level JSON value is not an object" };
    }
    return { status: "parsed", value: value as Record<string, unknown> };
  } catch (error) {
    return { status: "parse_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function findJsonObjectRange(text: string, from: number): { start: number; end: number } | undefined {
  const start = text.indexOf("{", from);
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start, end: index + 1 };
      }
    }
  }
  return undefined;
}
