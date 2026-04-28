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
  controlPollMs?: number;
};

export class PlanExecutor {
  private readonly store: FileStore;

  private readonly runManager: RunManager;

  private readonly adapters: CapabilityAdapterRegistry;

  private readonly now: () => Date;

  private readonly timeoutMsForStep: (step: PlanStep) => number;

  private readonly controlPollMs: number;

  constructor(options: PlanExecutorOptions) {
    this.store = options.store;
    this.runManager = options.runManager;
    this.adapters = options.adapters;
    this.now = options.now ?? (() => new Date());
    this.timeoutMsForStep = options.timeoutMsForStep ?? (step => step.timeout_sec * 1000);
    this.controlPollMs = options.controlPollMs ?? 500;
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
      const control = await this.waitUntilRunnable(input.runId);
      if (!control.accepted) {
        return control;
      }
      if (!control.shouldContinue) {
        return completedWithoutOverwritingExternalState(control.run, stepResults, events);
      }

      if (!shouldExecuteStep(step, sawFailure, sawFatalFailure)) {
        continue;
      }

      const stepResult = await this.executeStep(input.runId, step, validation.plan.failure_signals);
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

    const control = await this.waitUntilRunnable(input.runId);
    if (!control.accepted) {
      return control;
    }
    if (!control.shouldContinue) {
      return completedWithoutOverwritingExternalState(control.run, stepResults, events);
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

  private async waitUntilRunnable(
    runId: string
  ): Promise<{ accepted: true; shouldContinue: true } | { accepted: true; shouldContinue: false; run: StoredRun } | RejectedRuntimeAction> {
    while (true) {
      const run = await this.store.readRun(runId);
      if (run.status === "running") {
        return { accepted: true, shouldContinue: true };
      }
      if (run.status === "paused") {
        await sleep(this.controlPollMs);
        continue;
      }
      if (isTerminalRunState(run.status) || run.status === "collecting_evidence") {
        return { accepted: true, shouldContinue: false, run };
      }
      return rejected("invalid_request", `cannot continue plan while run ${runId} is ${run.status}`);
    }
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

  private async executeStep(
    runId: string,
    step: PlanStep,
    failureSignals: string[]
  ): Promise<{ step: ExecutedStepResult; events: RunEvent[] }> {
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
    events.push(...(await this.appendRuleMatchedEvents(runId, step, adapterResult, failureSignals)));
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

  private async appendRuleMatchedEvents(
    runId: string,
    step: PlanStep,
    adapterResult: CapabilityExecutionResult,
    failureSignals: string[]
  ): Promise<RunEvent[]> {
    if (step.capability !== "watch_serial") {
      return [];
    }
    const matchedPatterns = unique(readStringArray(adapterResult.output.patterns_matched)).filter(pattern =>
      isRelevantFailurePattern(pattern, failureSignals)
    );
    const events: RunEvent[] = [];
    for (const pattern of matchedPatterns) {
      events.push(
        await this.appendEvent(runId, {
          type: "rule_matched",
          severity: ruleSeverityForPattern(pattern),
          source: "rule_engine",
          step_id: step.id,
          summary: `${pattern} matched on serial`,
          payload: {
            rule_id: `serial.pattern.${safeRuleIdSegment(pattern)}`,
            source: "serial",
            kind: "pattern",
            pattern,
            step_id: step.id
          },
          evidence_refs: adapterResult.evidence_refs.length > 0 ? adapterResult.evidence_refs : undefined
        })
      );
    }
    return events;
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
    const capabilityAllowed = allowedCapabilitySet === undefined || allowedCapabilitySet.has(step.capability);
    if (!capabilityAllowed) {
      issues.push(`capability ${step.capability} is not available for this target/request`);
      continue;
    }
    issues.push(...validateCapabilityStep(step));
  }

  for (const capability of missingCapabilities) {
    issues.push(`missing adapter for ${capability}`);
  }

  if (issues.length > 0) {
    return { accepted: false, issues };
  }
  return { accepted: true, plan: parsed.data };
}

function validateCapabilityStep(step: PlanStep): string[] {
  const issues: string[] = [];
  const label = `step ${step.id} ${step.capability}`;
  const timeoutLimit = P0_CAPABILITY_TIMEOUT_LIMIT_SEC[step.capability];

  if (step.timeout_sec > timeoutLimit) {
    issues.push(`${label} timeout_sec must be <= ${timeoutLimit}`);
  }

  switch (step.capability) {
    case "flash":
      requireNonEmptyString(step, "artifact_ref", issues);
      requireNonEmptyString(step, "artifact_type", issues);
      break;
    case "push":
      requireNonEmptyString(step, "src_ref", issues);
      if (!isNonEmptyString(step.input.dst_path) || !step.input.dst_path.startsWith("/")) {
        issues.push(`${label} input.dst_path must be an absolute path`);
      }
      break;
    case "watch_serial":
      optionalPositiveInt(step, "duration_sec", issues);
      optionalStringArray(step, "patterns", issues);
      optionalMax(step, "duration_sec", timeoutLimit, issues);
      break;
    case "wait_adb":
      optionalPositiveInt(step, "timeout_sec", issues);
      optionalMax(step, "timeout_sec", timeoutLimit, issues);
      break;
    case "shell_exec":
      requireNonEmptyString(step, "command", issues);
      optionalPositiveInt(step, "timeout_sec", issues);
      optionalMax(step, "timeout_sec", timeoutLimit, issues);
      optionalInteger(step, "expected_exit_code", issues);
      break;
    case "check_process":
      requireNonEmptyString(step, "process_name", issues);
      break;
    case "collect_logs":
      requireStringArray(step, "items", issues);
      break;
    case "save_snapshot":
      requireNonEmptyString(step, "reason", issues);
      optionalStringArray(step, "include", issues);
      break;
    default:
      assertNeverCapability(step.capability);
  }

  return issues;
}

const P0_CAPABILITY_TIMEOUT_LIMIT_SEC: Record<CapabilityName, number> = {
  flash: 300,
  push: 60,
  watch_serial: 600,
  wait_adb: 180,
  shell_exec: 60,
  check_process: 30,
  collect_logs: 120,
  save_snapshot: 30
};

function requireNonEmptyString(step: PlanStep, key: string, issues: string[]): void {
  if (!isNonEmptyString(step.input[key])) {
    issues.push(`step ${step.id} ${step.capability} input.${key} must be a non-empty string`);
  }
}

function requireStringArray(step: PlanStep, key: string, issues: string[]): void {
  if (!isNonEmptyStringArray(step.input[key])) {
    issues.push(`step ${step.id} ${step.capability} input.${key} must be an array of non-empty strings`);
  }
}

function optionalStringArray(step: PlanStep, key: string, issues: string[]): void {
  const value = step.input[key];
  if (value !== undefined && !isStringArray(value)) {
    issues.push(`step ${step.id} ${step.capability} input.${key} must be an array of non-empty strings`);
  }
}

function optionalPositiveInt(step: PlanStep, key: string, issues: string[]): void {
  const value = step.input[key];
  if (value !== undefined && (!Number.isInteger(value) || typeof value !== "number" || value <= 0)) {
    issues.push(`step ${step.id} ${step.capability} input.${key} must be a positive integer`);
  }
}

function optionalInteger(step: PlanStep, key: string, issues: string[]): void {
  const value = step.input[key];
  if (value !== undefined && (!Number.isInteger(value) || typeof value !== "number")) {
    issues.push(`step ${step.id} ${step.capability} input.${key} must be an integer`);
  }
}

function optionalMax(step: PlanStep, key: string, max: number, issues: string[]): void {
  const value = step.input[key];
  if (typeof value === "number" && value > max) {
    issues.push(`step ${step.id} ${step.capability} input.${key} must be <= ${max}`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function isRelevantFailurePattern(pattern: string, failureSignals: string[]): boolean {
  if (isFatalPattern(pattern)) {
    return true;
  }
  const normalizedPattern = normalizeRuleText(pattern);
  return failureSignals.some(signal => {
    const normalizedSignal = normalizeRuleText(signal);
    return normalizedSignal.includes(normalizedPattern) || normalizedPattern.includes(normalizedSignal);
  });
}

function ruleSeverityForPattern(pattern: string): RunEvent["severity"] {
  return isFatalPattern(pattern) ? "error" : "warning";
}

function isFatalPattern(pattern: string): boolean {
  return /\b(panic|oops|fatal|crash|bug|assert)\b/i.test(pattern);
}

function normalizeRuleText(value: string): string {
  return value.trim().toLowerCase();
}

function safeRuleIdSegment(value: string): string {
  const segment = normalizeRuleText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return segment.length > 0 ? segment : "pattern";
}

function assertNeverCapability(capability: never): never {
  throw new Error(`Unhandled capability ${String(capability)}`);
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

function completedWithoutOverwritingExternalState(
  run: StoredRun,
  stepResults: ExecutedStepResult[],
  events: RunEvent[]
): PlanExecutionResult {
  return {
    accepted: true,
    run,
    step_results: stepResults,
    events,
    evidence_refs: unique(stepResults.flatMap(step => step.evidence_refs))
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function rejected(error_code: PublicErrorCode, message: string): RejectedRuntimeAction {
  return {
    accepted: false,
    error_code,
    message
  };
}
