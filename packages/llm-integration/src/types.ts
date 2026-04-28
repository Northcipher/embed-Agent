import type { z } from "zod";

export type LlmRole = "task_planner" | "observer" | "reply_generator";

export type PromptSection = {
  name: string;
  content: string;
};

export type PromptDefinition = {
  prompt_id: string;
  role: LlmRole;
  version: number;
  status: "active" | "deprecated";
  input_contract: string;
  output_contract: string;
  timeout_sec: number;
  max_input_chars: number;
  system: string;
  developer: string;
  user_sections: string[];
};

export type AssembledPrompt = {
  prompt_id: string;
  role: LlmRole;
  system: string;
  developer: string;
  user: string;
  truncated: boolean;
};

export type LlmCallInput = {
  callId: string;
  role: LlmRole;
  promptId: string;
  model: string;
  system: string;
  developer?: string;
  user: string;
  timeoutSec: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type LlmCallResult = {
  providerId: string;
  model: string;
  rawText: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
};

export interface LlmProvider {
  readonly providerId: string;
  completeJson(input: LlmCallInput): Promise<LlmCallResult>;
}

export type ParseResult =
  | {
      status: "parsed";
      value: Record<string, unknown>;
    }
  | {
      status: "parse_failed";
      error: string;
    };

export type ValidationResult<T> =
  | {
      status: "valid";
      value: T;
    }
  | {
      status: "invalid";
      reason: string;
      failure_status: "plan_rejected" | "clarification_needed" | "observer_intent_rejected" | "reply_rejected";
    };

export type SchemaLike<T> = z.ZodType<T>;
