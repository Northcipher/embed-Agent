import { randomUUID } from "node:crypto";
import type { CapabilityName, ObserverIntent, RunEvent } from "@artifact-validation/contracts";
import { BrainOutputStore, type BrainCallStatus } from "./brain-output-store.js";
import { LlmCallManager, type ManagedLlmCallResult } from "./call-manager.js";
import { assemblePrompt, createDefaultPromptRegistry, type PromptRegistry } from "./prompt-registry.js";
import type { LlmProvider } from "./types.js";
import { validateObserverIntent } from "./validators.js";

export type ObserverRunnerOptions = {
  provider: LlmProvider;
  model: string;
  registry?: PromptRegistry;
  callIdFactory?: (input: RunObserverInput) => string;
  now?: () => Date;
};

export type EvidenceWindow = {
  ref: string;
  kind: string;
  text: string;
};

export type RunObserverInput = {
  runId: string;
  runDir: string;
  run: Record<string, unknown>;
  targetState: Record<string, unknown>;
  triggerEvent: RunEvent;
  recentEvents: RunEvent[];
  evidenceWindows: EvidenceWindow[];
  remainingDurationSec: number;
  allowedFollowUpCapabilities: CapabilityName[];
};

export type ObserverRunnerResult =
  | {
      status: "accepted";
      intent: ObserverIntent;
      brain_call: string;
    }
  | {
      status: "rejected";
      reasons: string[];
      fallback_intent: ObserverIntent;
      brain_call: string;
    };

export class ObserverRunner {
  private readonly provider: LlmProvider;
  private readonly model: string;
  private readonly registry: PromptRegistry;
  private readonly callIdFactory: (input: RunObserverInput) => string;
  private readonly now: () => Date;

  constructor(options: ObserverRunnerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.registry = options.registry ?? createDefaultPromptRegistry();
    this.callIdFactory = options.callIdFactory ?? (() => `observer-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async observe(input: RunObserverInput): Promise<ObserverRunnerResult> {
    const definition = this.registry.getActiveByRole("observer");
    const prompt = assemblePrompt(definition, observerSections(input));
    const callId = this.callIdFactory(input);
    const startedAt = this.now().toISOString();
    const manager = new LlmCallManager(this.provider);
    const callResult = await manager.completeAndParse({
      callId,
      role: "observer",
      promptId: prompt.prompt_id,
      model: this.model,
      system: prompt.system,
      developer: prompt.developer,
      user: prompt.user,
      timeoutSec: definition.timeout_sec,
      metadata: {
        run_id: input.runId,
        trigger_event_seq: input.triggerEvent.seq,
        truncated: prompt.truncated
      }
    });
    const endedAt = this.now().toISOString();
    const brainStore = new BrainOutputStore({ runDir: input.runDir });

    if (callResult.status !== "parsed" || callResult.parse_result?.status !== "parsed") {
      const reason = callResult.error ?? `observer ${callResult.status}`;
      await recordFailedObserverCall(
        brainStore,
        input,
        prompt.prompt_id,
        prompt.truncated,
        callId,
        startedAt,
        endedAt,
        this.model,
        callResult,
        reason
      );
      return {
        status: "rejected",
        reasons: [reason],
        fallback_intent: fallbackObserverIntent(reason),
        brain_call: callId
      };
    }

    const validation = validateObserverIntent(callResult.parse_result.value, {
      allowedFollowUpCapabilities: input.allowedFollowUpCapabilities,
      remainingDurationSec: input.remainingDurationSec
    });
    await brainStore.writeCall({
      callId,
      role: "observer",
      promptId: prompt.prompt_id,
      startedAt,
      endedAt,
      status: validation.status === "valid" ? "validated" : "validation_failed",
      model: callResult.provider_result?.model ?? this.model,
      input: observerInputAudit(input, prompt.truncated),
      ...(callResult.provider_result?.providerId !== undefined ? { providerId: callResult.provider_result.providerId } : {}),
      ...(callResult.provider_result?.rawText !== undefined ? { rawOutput: callResult.provider_result.rawText } : {}),
      parsedOutput: callResult.parse_result.value,
      validation
    });

    if (validation.status === "invalid") {
      return {
        status: "rejected",
        reasons: [validation.reason],
        fallback_intent: fallbackObserverIntent(validation.reason),
        brain_call: callId
      };
    }

    return {
      status: "accepted",
      intent: validation.value,
      brain_call: callId
    };
  }
}

function observerSections(input: RunObserverInput) {
  return [
    { name: "run", content: json(input.run) },
    { name: "target_state", content: json(input.targetState) },
    { name: "trigger_event", content: json(input.triggerEvent) },
    { name: "recent_events", content: json(input.recentEvents) },
    { name: "evidence_windows", content: json(input.evidenceWindows) },
    {
      name: "constraints_remaining",
      content: json({
        remaining_duration_sec: input.remainingDurationSec,
        allowed_follow_up_capabilities: input.allowedFollowUpCapabilities
      })
    },
    { name: "output_schema", content: "ObserverIntent.v1" }
  ];
}

function observerInputAudit(input: RunObserverInput, truncated: boolean): Record<string, unknown> {
  return {
    role: "observer",
    truncated,
    run: input.run,
    target_state: input.targetState,
    trigger_event: input.triggerEvent,
    recent_events: input.recentEvents,
    evidence_windows: input.evidenceWindows,
    constraints_remaining: {
      remaining_duration_sec: input.remainingDurationSec,
      allowed_follow_up_capabilities: input.allowedFollowUpCapabilities
    },
    output_schema: "ObserverIntent.v1"
  };
}

async function recordFailedObserverCall(
  brainStore: BrainOutputStore,
  input: RunObserverInput,
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
    role: "observer",
    promptId,
    startedAt,
    endedAt,
    status: callStatusFromManager(callResult.status),
    model: callResult.provider_result?.model ?? model,
    input: observerInputAudit(input, truncated),
    ...(callResult.provider_result?.providerId !== undefined ? { providerId: callResult.provider_result.providerId } : {}),
    ...(callResult.provider_result?.rawText !== undefined ? { rawOutput: callResult.provider_result.rawText } : {}),
    validation: {
      status: "invalid",
      reason
    }
  });
}

function fallbackObserverIntent(reason: string): ObserverIntent {
  return {
    intent: "continue",
    reason: `Observer fallback: ${reason}`,
    confidence: 0,
    requested_actions: [],
    report_to_caller: false
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
