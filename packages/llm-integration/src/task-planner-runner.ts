import { randomUUID } from "node:crypto";
import type {
  CapabilityName,
  CapabilityStatus,
  Plan,
  TaskPlannerOutput,
  ValidateArtifactInput,
  ValidationIntent
} from "@artifact-validation/contracts";
import { BrainOutputStore, type BrainCallStatus } from "./brain-output-store.js";
import { LlmCallManager, type ManagedLlmCallResult } from "./call-manager.js";
import { assemblePrompt, createDefaultPromptRegistry, type PromptRegistry } from "./prompt-registry.js";
import type { LlmProvider } from "./types.js";
import { validateTaskPlannerOutput } from "./validators.js";

export type TaskPlannerRunnerOptions = {
  provider: LlmProvider;
  model: string;
  registry?: PromptRegistry;
  callIdFactory?: (input: RunTaskPlannerInput, attempt: number) => string;
  now?: () => Date;
  scenarioReferences?: unknown[];
};

export type RunTaskPlannerInput = {
  runId: string;
  runDir: string;
  request: ValidateArtifactInput;
  targetCapabilities: CapabilityStatus[];
};

export type TaskPlannerRunnerResult =
  | {
      status: "planned";
      plan: Plan;
      validation_intent: ValidationIntent;
      assumptions: string[];
      brain_call: string;
    }
  | {
      status: "clarification_needed";
      reasons: string[];
      missing_info: string[];
      suggested_next: string;
      brain_call: string;
    }
  | {
      status: "plan_rejected";
      reasons: string[];
      missing_info: string[];
      suggested_next: string;
      brain_call: string;
    };

export class TaskPlannerRunner {
  private readonly provider: LlmProvider;
  private readonly model: string;
  private readonly registry: PromptRegistry;
  private readonly callIdFactory: (input: RunTaskPlannerInput, attempt: number) => string;
  private readonly now: () => Date;
  private readonly scenarioReferences: unknown[];

  constructor(options: TaskPlannerRunnerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.registry = options.registry ?? createDefaultPromptRegistry();
    this.callIdFactory = options.callIdFactory ?? ((_, attempt) => `task-planner-${attempt}-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
    this.scenarioReferences = options.scenarioReferences ?? [];
  }

  async plan(input: RunTaskPlannerInput): Promise<TaskPlannerRunnerResult> {
    const definition = this.registry.getActiveByRole("task_planner");
    const prompt = assemblePrompt(definition, taskPlannerSections(input, this.scenarioReferences));
    const manager = new LlmCallManager(this.provider);
    const brainStore = new BrainOutputStore({ runDir: input.runDir });

    for (let attempt = 1; attempt <= TASK_PLANNER_MAX_ATTEMPTS; attempt += 1) {
      const callId = this.callIdFactory(input, attempt);
      const startedAt = this.now().toISOString();
      const callResult = await manager.completeAndParse({
        callId,
        role: "task_planner",
        promptId: prompt.prompt_id,
        model: this.model,
        system: prompt.system,
        developer: prompt.developer,
        user: prompt.user,
        timeoutSec: definition.timeout_sec,
        metadata: {
          run_id: input.runId,
          truncated: prompt.truncated,
          attempt
        }
      });
      const endedAt = this.now().toISOString();

      if (callResult.status !== "parsed" || callResult.parse_result?.status !== "parsed") {
        await this.recordFailedCall(brainStore, input, prompt.prompt_id, prompt.truncated, callId, startedAt, endedAt, callResult);
        if (callResult.status === "provider_error" && attempt < TASK_PLANNER_MAX_ATTEMPTS) {
          continue;
        }
        const reason = callResult.error ?? `task planner ${callResult.status}`;
        return {
          status: "clarification_needed",
          reasons: [reason],
          missing_info: ["Task Planner did not return valid JSON"],
          suggested_next: "Retry with a valid Task Planner output or use a hand-written Plan.",
          brain_call: callId
        };
      }

      const validation = validateTaskPlannerOutput(callResult.parse_result.value, {
        availableCapabilities: availableCapabilityNames(input.targetCapabilities),
        hasTestHint: input.request.context.test_hint !== undefined
      });
      await brainStore.writeCall({
        callId,
        role: "task_planner",
        promptId: prompt.prompt_id,
        startedAt,
        endedAt,
        status: validation.status === "valid" ? "validated" : "validation_failed",
        model: callResult.provider_result?.model ?? this.model,
        input: promptInputAudit(input, prompt.truncated, this.scenarioReferences),
        ...(callResult.provider_result?.providerId !== undefined ? { providerId: callResult.provider_result.providerId } : {}),
        ...(callResult.provider_result?.rawText !== undefined ? { rawOutput: callResult.provider_result.rawText } : {}),
        parsedOutput: callResult.parse_result.value,
        validation
      });

      if (validation.status === "invalid") {
        const rejectedStatus = validation.failure_status === "clarification_needed" ? "clarification_needed" : "plan_rejected";
        return {
          status: rejectedStatus,
          reasons: [validation.reason],
          missing_info: rejectedStatus === "clarification_needed" ? ["Task Planner output needs more input"] : [],
          suggested_next:
            rejectedStatus === "clarification_needed"
              ? "Provide the missing validation input and retry."
              : "Fix Task Planner output so it passes Runtime policy validation.",
          brain_call: callId
        };
      }

      return taskPlannerResultFromValidOutput(validation.value, callId);
    }

    return {
      status: "clarification_needed",
      reasons: ["Task Planner exhausted retry attempts"],
      missing_info: ["Task Planner did not return valid JSON"],
      suggested_next: "Retry with a valid Task Planner output or use a hand-written Plan.",
      brain_call: "task-planner-unavailable"
    };
  }

  private async recordFailedCall(
    brainStore: BrainOutputStore,
    input: RunTaskPlannerInput,
    promptId: string,
    truncated: boolean,
    callId: string,
    startedAt: string,
    endedAt: string,
    callResult: ManagedLlmCallResult
  ): Promise<void> {
    const reason = callResult.error ?? `task planner ${callResult.status}`;
    await brainStore.writeCall({
      callId,
      role: "task_planner",
      promptId,
      startedAt,
      endedAt,
      status: callStatusFromManager(callResult.status),
      model: callResult.provider_result?.model ?? this.model,
      input: promptInputAudit(input, truncated, this.scenarioReferences),
      ...(callResult.provider_result?.providerId !== undefined ? { providerId: callResult.provider_result.providerId } : {}),
      ...(callResult.provider_result?.rawText !== undefined ? { rawOutput: callResult.provider_result.rawText } : {}),
      validation: {
        status: "invalid",
        reason
      }
    });
  }
}

function taskPlannerResultFromValidOutput(output: TaskPlannerOutput, callId: string): TaskPlannerRunnerResult {
  if (output.status === "clarification_needed") {
    return {
      status: "clarification_needed",
      reasons: [output.reason],
      missing_info: output.missing_info,
      suggested_next: output.suggested_next,
      brain_call: callId
    };
  }
  return {
    status: "planned",
    plan: output.plan,
    validation_intent: output.validation_intent,
    assumptions: output.assumptions,
    brain_call: callId
  };
}

function taskPlannerSections(input: RunTaskPlannerInput, scenarioReferences: unknown[]) {
  return [
    { name: "request", content: json(promptRequest(input.request)) },
    { name: "target_capabilities", content: json(input.targetCapabilities) },
    { name: "constraints", content: json(input.request.constraints) },
    { name: "scenario_references", content: json(scenarioReferences) },
    { name: "output_schema", content: TASK_PLANNER_OUTPUT_SCHEMA_DESCRIPTION }
  ];
}

function promptInputAudit(input: RunTaskPlannerInput, truncated: boolean, scenarioReferences: unknown[]): Record<string, unknown> {
  return {
    role: "task_planner",
    truncated,
    request: promptRequest(input.request),
    target_capabilities: input.targetCapabilities,
    constraints_effective: input.request.constraints,
    scenario_references: scenarioReferences,
    output_schema: "TaskPlannerOutput.v1"
  };
}

function promptRequest(request: ValidateArtifactInput): Record<string, unknown> {
  return {
    context: request.context,
    artifact: request.artifact,
    target: request.target,
    constraints: request.constraints
  };
}

function availableCapabilityNames(capabilities: CapabilityStatus[]): CapabilityName[] {
  return capabilities.filter(capability => capability.available).map(capability => capability.name);
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

const TASK_PLANNER_OUTPUT_SCHEMA_DESCRIPTION = [
  "Return exactly one JSON object.",
  "Allowed status values: planned, clarification_needed.",
  "planned requires validation_intent, plan, missing_info=[], assumptions[].",
  "clarification_needed requires reason, missing_info[], suggested_next.",
  "Plan steps must use only available target_capabilities and must not include connection parameters.",
  "Do not invent shell_exec command when context.test_hint is missing."
].join("\n");

const TASK_PLANNER_MAX_ATTEMPTS = 2;
