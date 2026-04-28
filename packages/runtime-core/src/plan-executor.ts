import type { CapabilityAdapterRegistry, CapabilityExecutionResult } from "@artifact-validation/adapters";
import {
  PlanSchema,
  type CapabilityName,
  type Plan,
  type PlanStep,
  type PublicErrorCode,
  type RunEvent,
  type RunState
} from "@artifact-validation/contracts";
import { type AppendEventInput, type FileStore, type StoredRun } from "@artifact-validation/file-store";
import { type RejectedRuntimeAction, RunManager, type TransitionRunResult } from "./run-manager.js";
import { isTerminalRunState } from "./state-machine.js";

export type ExecutePlanInput = {
  runId: string;
  plan: Plan;
  allowedCapabilities?: CapabilityName[];
};

export type ExecutedStepResult = {
  step_id: string;
  capability: CapabilityName;
  status: CapabilityExecutionResult["status"];
  success: boolean;
  summary: string;
  evidence_refs: string[];
  output: Record<string, unknown>;
};

export type PlanExecutionResult =
  | {
      accepted: true;
      run: StoredRun;
      step_results: ExecutedStepResult[];
      events: RunEvent[];
      evidence_refs: string[];
    }
  | RejectedRuntimeAction;

export type PlanValidationResult =
  | {
      accepted: true;
      plan: Plan;
    }
  | {
      accepted: false;
      issues: string[];
    };

export type PlanExecutorOptions = {
  store: FileStore;
  runManager: RunManager;
  adapters: CapabilityAdapterRegistry;
  now?: () => Date;
  timeoutMsForStep?: (step: PlanStep) => number;
};

export class PlanExecutor {
  private readonly store: FileStore;

  private readonly runManager: RunManager;

  private readonly adapters: CapabilityAdapterRegistry;

  private readonly now: () => Date;

  private readonly timeoutMsForStep: (step: PlanStep) => number;

  constructor(options: PlanExecutorOptions) {
    this.store = options.store;
    this.runManager = options.runManager;
    this.adapters = options.adapters;
    this.now = options.now ?? (() => new Date());
    this.timeoutMsForStep = options.timeoutMsForStep ?? (step => step.timeout_sec * 1000);
  }

  async executePlan(input: ExecutePlanInput): Promise<PlanExecutionResult> {
    const validation = validatePlanForExecution(input.plan, this.adapters, input.allowedCapabilities);
    if (!validation.accepted) {
      await this.failRejectedPlanningRun(input.runId, validation.issues.join("; "));
      return rejected("plan_rejected", `plan ${input.plan.plan_id} cannot execute: ${validation.issues.join("; ")}`);
    }

    const started = await this.transitionToRunning(input.runId);
    if (!started.accepted) {
      return started;
    }

    const events: RunEvent[] = [...started.events];
    const stepResults: ExecutedStepResult[] = [];
    let sawFailure = false;
    let sawFatalFailure = false;

    for (const step of validation.plan.steps) {
      if (!shouldExecuteStep(step, sawFailure, sawFatalFailure)) {
        continue;
      }

      const stepResult = await this.executeStep(input.runId, step);
      events.push(...stepResult.events);
      stepResults.push(stepResult.step);

      if (!stepResult.step.success || stepResult.step.status !== "completed") {
        sawFailure = true;
        const failurePolicy = step.on_failure ?? "collect_and_fail";
        if (failurePolicy !== "continue") {
          sawFatalFailure = true;
        }
        if (failurePolicy === "fail") {
          break;
        }
      }
    }

    const collecting = await this.runManager.transitionRun({
      runId: input.runId,
      to: "collecting_evidence",
      reason: "plan execution finished",
      source: "orchestrator"
    });
    if (!collecting.accepted) {
      return collecting;
    }
    events.push(...collecting.events);

    const finalState: RunState = sawFatalFailure ? "failed" : "completed";
    const finished = await this.runManager.transitionRun({
      runId: input.runId,
      to: finalState,
      reason: sawFatalFailure ? "plan finished with fatal step failure" : "plan finished successfully",
      source: "orchestrator"
    });
    if (!finished.accepted) {
      return finished;
    }
    events.push(...finished.events);

    return {
      accepted: true,
      run: finished.run,
      step_results: stepResults,
      events,
      evidence_refs: unique(stepResults.flatMap(step => step.evidence_refs))
    };
  }

  private async transitionToRunning(runId: string): Promise<TransitionRunResult> {
    const current = await this.store.readRun(runId);
    const events: RunEvent[] = [];

    if (current.status === "queued") {
      const planning = await this.runManager.transitionRun({
        runId,
        to: "planning",
        reason: "plan executor accepted run",
        source: "orchestrator"
      });
      if (!planning.accepted) {
        return planning;
      }
      events.push(...planning.events);
    } else if (current.status !== "planning") {
      return rejected("invalid_request", `cannot execute plan while run ${runId} is ${current.status}`);
    }

    const running = await this.runManager.transitionRun({
      runId,
      to: "running",
      reason: "plan accepted",
      source: "orchestrator"
    });
    if (!running.accepted) {
      return running;
    }

    return {
      accepted: true,
      run: running.run,
      events: [...events, ...running.events]
    };
  }

  private async executeStep(runId: string, step: PlanStep): Promise<{ step: ExecutedStepResult; events: RunEvent[] }> {
    const started = await this.appendEvent(runId, {
      type: "step_started",
      severity: "info",
      source: "orchestrator",
      step_id: step.id,
      summary: `step ${step.id} started`,
      payload: {
        capability: step.capability,
        timeout_sec: step.timeout_sec
      }
    });

    const adapter = this.adapters.get(step.capability);
    let adapterResult: CapabilityExecutionResult;

    try {
      if (adapter === undefined) {
        throw new Error(`missing adapter for ${step.capability}`);
      }
      adapterResult = await this.executeAdapterWithTimeout(runId, step, adapter);
    } catch (error) {
      adapterResult = {
        capability: step.capability,
        success: false,
        status: "failed",
        output: {},
        evidence_refs: [],
        summary: error instanceof Error ? error.message : "adapter failed"
      };
    }

    const success = adapterResult.success && adapterResult.status === "completed";
    const stepEvent = await this.appendEvent(runId, {
      type: stepEventType(adapterResult),
      severity: success ? "info" : adapterResult.status === "timeout" ? "error" : "warning",
      source: "tool_adapter",
      step_id: step.id,
      summary: adapterResult.summary,
      payload: {
        capability: step.capability,
        status: adapterResult.status,
        success
      },
      evidence_refs: adapterResult.evidence_refs.length > 0 ? adapterResult.evidence_refs : undefined
    });

    const events = [started, stepEvent];
    if (adapterResult.evidence_refs.length > 0) {
      events.push(
        await this.appendEvent(runId, {
          type: "evidence_collected",
          severity: "info",
          source: "evidence_store",
          step_id: step.id,
          summary: `step ${step.id} collected ${adapterResult.evidence_refs.length} evidence ref(s)`,
          payload: {
            capability: step.capability
          },
          evidence_refs: adapterResult.evidence_refs
        })
      );
    }

    return {
      step: {
        step_id: step.id,
        capability: step.capability,
        status: adapterResult.status,
        success,
        summary: adapterResult.summary,
        evidence_refs: adapterResult.evidence_refs,
        output: adapterResult.output
      },
      events
    };
  }

  private async executeAdapterWithTimeout(
    runId: string,
    step: PlanStep,
    adapter: NonNullable<ReturnType<CapabilityAdapterRegistry["get"]>>
  ): Promise<CapabilityExecutionResult> {
    const timeoutMs = Math.max(0, this.timeoutMsForStep(step));
    let timeout: NodeJS.Timeout | undefined;
    const adapterPromise = adapter.execute({ runId, step, store: this.store });
    adapterPromise.catch(() => undefined);

    try {
      return await Promise.race([
        adapterPromise,
        new Promise<CapabilityExecutionResult>(resolve => {
          timeout = setTimeout(() => {
            resolve({
              capability: step.capability,
              success: false,
              status: "timeout",
              output: {
                timeout_sec: step.timeout_sec
              },
              evidence_refs: [],
              summary: `step ${step.id} timed out after ${step.timeout_sec}s`
            });
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async appendEvent(runId: string, event: Omit<AppendEventInput, "time" | "elapsed_sec">): Promise<RunEvent> {
    const run = await this.store.readRun(runId);
    return this.store.appendEvent(runId, {
      ...event,
      time: this.now().toISOString(),
      elapsed_sec: elapsedSec(run.created_at, this.now())
    });
  }

  private async failRejectedPlanningRun(runId: string, reason: string): Promise<void> {
    const run = await this.store.readRun(runId);
    if (isTerminalRunState(run.status)) {
      return;
    }
    if (run.status === "queued") {
      const planning = await this.runManager.transitionRun({
        runId,
        to: "planning",
        reason: "plan rejected before execution",
        source: "orchestrator"
      });
      if (!planning.accepted) {
        return;
      }
    }
    const current = await this.store.readRun(runId);
    if (current.status === "planning") {
      await this.runManager.transitionRun({
        runId,
        to: "failed",
        reason,
        source: "orchestrator"
      });
    }
  }
}

export function validatePlanForExecution(
  plan: Plan,
  adapters: CapabilityAdapterRegistry,
  allowedCapabilities?: CapabilityName[]
): PlanValidationResult {
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    return {
      accepted: false,
      issues: parsed.error.issues.map(issue => `${issue.path.join(".") || "plan"}: ${issue.message}`)
    };
  }

  const issues: string[] = [];
  const seenStepIds = new Set<string>();
  const missingCapabilities = new Set<CapabilityName>();
  const allowedCapabilitySet = allowedCapabilities === undefined ? undefined : new Set(allowedCapabilities);

  for (const step of parsed.data.steps) {
    if (seenStepIds.has(step.id)) {
      issues.push(`duplicate step id ${step.id}`);
    }
    seenStepIds.add(step.id);

    if (adapters.get(step.capability) === undefined) {
      missingCapabilities.add(step.capability);
    }
    if (allowedCapabilitySet !== undefined && !allowedCapabilitySet.has(step.capability)) {
      issues.push(`capability ${step.capability} is not available for this target/request`);
    }
  }

  for (const capability of missingCapabilities) {
    issues.push(`missing adapter for ${capability}`);
  }

  if (issues.length > 0) {
    return { accepted: false, issues };
  }
  return { accepted: true, plan: parsed.data };
}

function shouldExecuteStep(step: PlanStep, sawFailure: boolean, sawFatalFailure: boolean): boolean {
  if (sawFatalFailure) {
    return step.condition === "on_failure";
  }
  if (step.condition === "always") {
    return true;
  }
  if (step.condition === "on_success") {
    return !sawFailure;
  }
  return sawFailure;
}

function stepEventType(result: CapabilityExecutionResult): RunEvent["type"] {
  if (result.status === "timeout") {
    return "step_timeout";
  }
  if (result.success && result.status === "completed") {
    return "step_completed";
  }
  return "step_failed";
}

function elapsedSec(createdAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(createdAt).getTime()) / 1000);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function rejected(error_code: PublicErrorCode, message: string): RejectedRuntimeAction {
  return {
    accepted: false,
    error_code,
    message
  };
}
