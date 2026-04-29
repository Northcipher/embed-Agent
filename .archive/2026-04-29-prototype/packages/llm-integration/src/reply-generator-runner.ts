import { randomUUID } from "node:crypto";
import type { AgentReply } from "@artifact-validation/contracts";
import { BrainOutputStore, type BrainCallStatus } from "./brain-output-store.js";
import { LlmCallManager, type ManagedLlmCallResult } from "./call-manager.js";
import { assemblePrompt, createDefaultPromptRegistry, type PromptRegistry } from "./prompt-registry.js";
import type { LlmProvider } from "./types.js";
import { createRuleBasedReply, validateAgentReply } from "./validators.js";

export type ReplyGeneratorRunnerOptions = {
  provider: LlmProvider;
  model: string;
  registry?: PromptRegistry;
  callIdFactory?: (input: RunReplyGeneratorInput) => string;
  now?: () => Date;
};

export type RunReplyGeneratorInput = {
  runId: string;
  runDir: string;
  finalStatus: AgentReply["status"];
  evidencePath: string;
  evidenceRefs: string[];
  requestSummary: Record<string, unknown>;
  run: Record<string, unknown>;
  eventSummary: unknown[];
  evidenceIndex: unknown;
  observerNotes: unknown[];
};

export type ReplyGeneratorRunnerResult =
  | {
      status: "generated";
      reply: AgentReply;
      brain_call: string;
    }
  | {
      status: "fallback";
      reply: AgentReply;
      reasons: string[];
      brain_call: string;
    };

export class ReplyGeneratorRunner {
  private readonly provider: LlmProvider;
  private readonly model: string;
  private readonly registry: PromptRegistry;
  private readonly callIdFactory: (input: RunReplyGeneratorInput) => string;
  private readonly now: () => Date;

  constructor(options: ReplyGeneratorRunnerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.registry = options.registry ?? createDefaultPromptRegistry();
    this.callIdFactory = options.callIdFactory ?? (() => `reply-generator-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async generate(input: RunReplyGeneratorInput): Promise<ReplyGeneratorRunnerResult> {
    const definition = this.registry.getActiveByRole("reply_generator");
    const prompt = assemblePrompt(definition, replySections(input));
    const callId = this.callIdFactory(input);
    const startedAt = this.now().toISOString();
    const manager = new LlmCallManager(this.provider);
    const callResult = await manager.completeAndParse({
      callId,
      role: "reply_generator",
      promptId: prompt.prompt_id,
      model: this.model,
      system: prompt.system,
      developer: prompt.developer,
      user: prompt.user,
      timeoutSec: definition.timeout_sec,
      metadata: {
        run_id: input.runId,
        truncated: prompt.truncated
      }
    });
    const endedAt = this.now().toISOString();
    const brainStore = new BrainOutputStore({ runDir: input.runDir });

    if (callResult.status !== "parsed" || callResult.parse_result?.status !== "parsed") {
      const reason = callResult.error ?? `reply generator ${callResult.status}`;
      await recordFailedReplyCall(brainStore, input, prompt.prompt_id, prompt.truncated, callId, startedAt, endedAt, this.model, callResult, reason);
      return fallbackReply(input, callId, reason);
    }

    const validation = validateAgentReply(callResult.parse_result.value, {
      runId: input.runId,
      finalStatus: input.finalStatus,
      evidenceRefs: input.evidenceRefs
    });
    await brainStore.writeCall({
      callId,
      role: "reply_generator",
      promptId: prompt.prompt_id,
      startedAt,
      endedAt,
      status: validation.status === "valid" ? "validated" : "validation_failed",
      model: callResult.provider_result?.model ?? this.model,
      input: replyInputAudit(input, prompt.truncated),
      ...(callResult.provider_result?.providerId !== undefined ? { providerId: callResult.provider_result.providerId } : {}),
      ...(callResult.provider_result?.rawText !== undefined ? { rawOutput: callResult.provider_result.rawText } : {}),
      parsedOutput: callResult.parse_result.value,
      validation
    });

    if (validation.status === "invalid") {
      return fallbackReply(input, callId, validation.reason);
    }

    return {
      status: "generated",
      reply: validation.value,
      brain_call: callId
    };
  }
}

function replySections(input: RunReplyGeneratorInput) {
  return [
    { name: "request_summary", content: json(input.requestSummary) },
    { name: "run", content: json(input.run) },
    { name: "event_summary", content: json(input.eventSummary) },
    { name: "evidence_index", content: json(input.evidenceIndex) },
    { name: "observer_notes", content: json(input.observerNotes) },
    { name: "output_schema", content: "AgentReply.v1" }
  ];
}

function replyInputAudit(input: RunReplyGeneratorInput, truncated: boolean): Record<string, unknown> {
  return {
    role: "reply_generator",
    truncated,
    request_summary: input.requestSummary,
    run: input.run,
    event_summary: input.eventSummary,
    evidence_index: input.evidenceIndex,
    observer_notes: input.observerNotes,
    output_schema: "AgentReply.v1"
  };
}

async function recordFailedReplyCall(
  brainStore: BrainOutputStore,
  input: RunReplyGeneratorInput,
  promptId: string,
  truncated: boolean,
  callId: string,
  startedAt: string,
  endedAt: string,
  model: string,
  callResult: ManagedLlmCallResult,
  reason: string
): Promise<void> {
  await brainStore.writeCall({
    callId,
    role: "reply_generator",
    promptId,
    startedAt,
    endedAt,
    status: callStatusFromManager(callResult.status),
    model: callResult.provider_result?.model ?? model,
    input: replyInputAudit(input, truncated),
    ...(callResult.provider_result?.providerId !== undefined ? { providerId: callResult.provider_result.providerId } : {}),
    ...(callResult.provider_result?.rawText !== undefined ? { rawOutput: callResult.provider_result.rawText } : {}),
    validation: {
      status: "invalid",
      reason
    }
  });
}

function fallbackReply(input: RunReplyGeneratorInput, callId: string, reason: string): ReplyGeneratorRunnerResult {
  return {
    status: "fallback",
    reply: createRuleBasedReply({
      runId: input.runId,
      status: input.finalStatus,
      evidencePath: input.evidencePath,
      summary: `${input.finalStatus}; Reply Generator fallback: ${reason}`
    }),
    reasons: [reason],
    brain_call: callId
  };
}

function callStatusFromManager(status: "parsed" | "parse_failed" | "timeout" | "provider_error"): BrainCallStatus {
  if (status === "timeout" || status === "provider_error" || status === "parse_failed") {
    return status;
  }
  return "validation_failed";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
