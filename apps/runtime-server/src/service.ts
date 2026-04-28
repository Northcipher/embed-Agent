import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { CapabilityAdapterRegistry } from "@artifact-validation/adapters";
import {
  type AgentReply,
  type CapabilityName,
  type CapabilityStatus,
  type CancelRunResponse,
  type GetEvidenceResponse,
  type GetRunEventsResponse,
  type GetRunResultResponse,
  type GetTargetCapabilitiesResponse,
  type InterveneRunInput,
  type InterveneRunResponse,
  type Plan,
  type RunEvent,
  type RunState,
  type RunStatusResponse,
  type ValidateArtifactAcceptedResponse,
  type ValidateArtifactInput,
  type ValidateArtifactRejectedResponse
} from "@artifact-validation/contracts";
import { FileStore } from "@artifact-validation/file-store";
import { PlanExecutor, RunManager } from "@artifact-validation/runtime-core";
import { RuntimeHttpError, resourceNotFound, runNotFound, unsupportedAction } from "./errors.js";

export type PlanFactory = (input: ValidateArtifactInput) => Plan | undefined | Promise<Plan | undefined>;

export type RuntimeTaskPlannerInput = {
  runId: string;
  runDir: string;
  request: ValidateArtifactInput;
  targetCapabilities: CapabilityStatus[];
};

export type RuntimeTaskPlannerResult =
  | {
      status: "planned";
      plan: Plan;
      brain_call?: string;
    }
  | {
      status: "clarification_needed" | "plan_rejected";
      reasons: string[];
      missing_info: string[];
      suggested_next: string;
      brain_call?: string;
    };

export type RuntimeTaskPlanner = {
  plan(input: RuntimeTaskPlannerInput): Promise<RuntimeTaskPlannerResult>;
};

export type RuntimeServiceOptions = {
  rootDir: string;
  adapters: CapabilityAdapterRegistry;
  planFactory?: PlanFactory;
  taskPlanner?: RuntimeTaskPlanner;
  executePlansInline?: boolean;
  idFactory?: () => string;
  now?: () => Date;
};

export type ValidateArtifactServiceResponse = ValidateArtifactAcceptedResponse | ValidateArtifactRejectedResponse;

export class RuntimeService {
  readonly store: FileStore;

  readonly runManager: RunManager;

  private readonly executor: PlanExecutor;

  private readonly adapters: CapabilityAdapterRegistry;

  private readonly planFactory: PlanFactory | undefined;

  private readonly taskPlanner: RuntimeTaskPlanner | undefined;

  private readonly executePlansInline: boolean;

  private readonly idFactory: () => string;

  private readonly now: () => Date;

  constructor(options: RuntimeServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.store = new FileStore({ rootDir: options.rootDir, now: this.now });
    this.runManager = new RunManager({ store: this.store, now: this.now });
    this.adapters = options.adapters;
    this.executor = new PlanExecutor({
      store: this.store,
      runManager: this.runManager,
      adapters: this.adapters,
      now: this.now
    });
    this.planFactory = options.planFactory;
    this.taskPlanner = options.taskPlanner;
    this.executePlansInline = options.executePlansInline ?? false;
    this.idFactory = options.idFactory ?? (() => `run-${randomUUID()}`);
  }

  async validateArtifact(input: ValidateArtifactInput): Promise<ValidateArtifactServiceResponse> {
    const artifactValidation = await this.validateArtifactFile(input);
    if (artifactValidation !== undefined) {
      return artifactValidation;
    }

    const runId = this.idFactory();
    const targetCapabilities = this.capabilityStatuses();
    const created = await this.runManager.createRun({
      runId,
      initialState: "planning",
      request: input,
      inferredCapabilities: targetCapabilities
    });
    if (!created.accepted) {
      throw new RuntimeHttpError(400, created.error_code, created.message);
    }

    const plannerResult = await this.createPlanForRun(runId, created.run.evidence_path, input, targetCapabilities);
    if (plannerResult.status !== "planned" && plannerResult.status !== "no_plan") {
      await this.failPlanningRun(runId, plannerResult.reasons.join("; "));
      return {
        status: plannerResult.status,
        run_id: runId,
        target: input.target,
        reasons: plannerResult.reasons,
        missing_info: plannerResult.missing_info,
        suggested_next: plannerResult.suggested_next
      };
    }

    const plan = plannerResult.status === "planned" ? plannerResult.plan : undefined;
    if (plan !== undefined) {
      if (this.executePlansInline) {
        const execution = await this.executor.executePlan({ runId, plan });
        if (!execution.accepted) {
          await this.failPlanningRun(runId, execution.message);
          return {
            status: "plan_rejected",
            run_id: runId,
            target: input.target,
            reasons: [execution.message],
            missing_info: [],
            suggested_next: "Fix the hand-written plan or planner output and retry."
          };
        }
      } else {
        this.startBackgroundPlan(runId, plan);
      }
    }

    const run = await this.store.readRun(runId);
    return {
      status: "accepted",
      run_id: runId,
      target: input.target,
      state: run.status,
      evidence_path: run.evidence_path
    };
  }

  private async createPlanForRun(
    runId: string,
    runDir: string,
    input: ValidateArtifactInput,
    targetCapabilities: CapabilityStatus[]
  ): Promise<
    | { status: "planned"; plan: Plan }
    | { status: "no_plan" }
    | { status: "clarification_needed" | "plan_rejected"; reasons: string[]; missing_info: string[]; suggested_next: string }
  > {
    const handWrittenPlan = await this.planFactory?.(input);
    if (handWrittenPlan !== undefined) {
      return { status: "planned", plan: handWrittenPlan };
    }
    if (this.taskPlanner === undefined) {
      return { status: "no_plan" };
    }
    try {
      const plannerResult = await this.taskPlanner.plan({
        runId,
        runDir,
        request: input,
        targetCapabilities
      });
      if (plannerResult.status === "planned") {
        return { status: "planned", plan: plannerResult.plan };
      }
      return plannerResult;
    } catch (error) {
      return {
        status: "plan_rejected",
        reasons: [error instanceof Error ? error.message : "Task Planner failed"],
        missing_info: [],
        suggested_next: "Fix Task Planner integration or use a hand-written Plan."
      };
    }
  }

  private async failPlanningRun(runId: string, reason: string): Promise<void> {
    const current = await this.readRunOrThrow(runId);
    if (current.status !== "planning") {
      return;
    }
    await this.runManager.transitionRun({
      runId,
      to: "failed",
      reason,
      source: "orchestrator"
    });
  }

  async getRunStatus(runId: string): Promise<RunStatusResponse> {
    const run = await this.readRunOrThrow(runId);
    return {
      run_id: run.run_id,
      status: run.status,
      target: {
        state: run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? "idle" : "busy",
        current_run_id: run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? null : run.run_id,
        updated_at: run.updated_at
      },
      elapsed_sec: elapsedSec(run.created_at, this.now()),
      last_event_seq: run.last_event_seq,
      evidence_path: run.evidence_path
    };
  }

  async getRunEvents(runId: string, options: { afterSeq: number; limit: number }): Promise<GetRunEventsResponse> {
    await this.readRunOrThrow(runId);
    const events = await this.store.readEvents(runId, {
      afterSeq: options.afterSeq,
      limit: options.limit + 1
    });
    const visibleEvents = events.slice(0, options.limit);
    return {
      run_id: runId,
      events: visibleEvents,
      next_after_seq: lastSeq(visibleEvents, options.afterSeq),
      has_more: events.length > visibleEvents.length
    };
  }

  async getEvidence(runId: string, ref?: string): Promise<GetEvidenceResponse> {
    await this.readRunOrThrow(runId);
    const index = await this.store.readEvidenceIndex(runId);
    if (ref === undefined) {
      return index;
    }
    const evidenceRef = index.refs.find(item => item.ref === ref);
    if (evidenceRef === undefined) {
      throw resourceNotFound(`evidence ref ${ref} was not found`);
    }
    return evidenceRef;
  }

  async getRunResult(runId: string): Promise<GetRunResultResponse> {
    const run = await this.readRunOrThrow(runId);
    const reply = await this.tryReadAgentReply(runId);
    if (reply !== undefined) {
      return reply;
    }
    return {
      run_id: runId,
      status: run.status,
      result_available: false
    };
  }

  async interveneRun(input: InterveneRunInput): Promise<InterveneRunResponse> {
    const run = await this.readRunOrThrow(input.run_id);

    if (input.action === "pause") {
      return this.transitionIntervention(input, "paused", input.reason ?? "pause intervention");
    }
    if (input.action === "resume") {
      return this.transitionIntervention(input, "running", input.reason ?? "resume intervention");
    }
    if (input.action === "cancel") {
      const cancelled = await this.cancelRun(input.run_id, input.reason);
      return {
        run_id: input.run_id,
        accepted: true,
        action: input.action,
        status: cancelled.status,
        reason: input.reason
      };
    }

    const event = await this.store.appendEvent(input.run_id, {
      time: this.now().toISOString(),
      elapsed_sec: elapsedSec(run.created_at, this.now()),
      type: "intervention_requested",
      severity: "info",
      source: "caller",
      summary: `intervention ${input.action} accepted`,
      payload: input
    });
    return {
      run_id: input.run_id,
      accepted: true,
      action: input.action,
      status: run.status,
      event_seq: event.seq,
      reason: input.reason
    };
  }

  async cancelRun(runId: string, reason?: string): Promise<CancelRunResponse> {
    const run = await this.readRunOrThrow(runId);
    if (run.status === "cancelled") {
      return {
        run_id: runId,
        status: "cancelled",
        evidence_path: run.evidence_path
      };
    }

    const transitioned = await this.runManager.transitionRun({
      runId,
      to: "cancelled",
      reason: reason ?? "cancel requested",
      source: "caller"
    });
    if (!transitioned.accepted) {
      throw unsupportedAction(transitioned.message);
    }
    return {
      run_id: runId,
      status: "cancelled",
      evidence_path: transitioned.run.evidence_path
    };
  }

  getTargetCapabilities(target: string): GetTargetCapabilitiesResponse {
    return {
      target,
      runtime_state: {
        target_id: target,
        state: "unknown"
      },
      capabilities: this.capabilityStatuses()
    };
  }

  private async transitionIntervention(input: InterveneRunInput, to: RunState, reason: string): Promise<InterveneRunResponse> {
    const transitioned = await this.runManager.transitionRun({
      runId: input.run_id,
      to,
      reason,
      source: "caller"
    });
    if (!transitioned.accepted) {
      return {
        run_id: input.run_id,
        accepted: false,
        action: input.action,
        status: (await this.readRunOrThrow(input.run_id)).status,
        reason: transitioned.message
      };
    }
    return {
      run_id: input.run_id,
      accepted: true,
      action: input.action,
      status: transitioned.run.status,
      event_seq: lastSeq(transitioned.events, 0),
      reason
    };
  }

  private async validateArtifactFile(input: ValidateArtifactInput): Promise<ValidateArtifactRejectedResponse | undefined> {
    try {
      const artifactStat = await stat(input.artifact.path);
      if (!artifactStat.isFile()) {
        return artifactInvalid(input, "artifact path is not a file");
      }
    } catch {
      return artifactInvalid(input, "artifact file does not exist or is not readable");
    }

    if (input.context.test_hint !== undefined && input.context.test_hint.kind !== "adb_shell") {
      return {
        status: "clarification_needed",
        target: input.target,
        reasons: [`test_hint kind ${input.context.test_hint.kind} is not supported in P0`],
        missing_info: ["P0 requires test_hint.kind=adb_shell or a configured hand-written plan"],
        suggested_next: "Provide an adb_shell test_hint or configure a hand-written Plan factory."
      };
    }
    return undefined;
  }

  private capabilityStatuses(): CapabilityStatus[] {
    return P0_CAPABILITIES.map(capability => ({
      name: capability,
      available: this.adapters.get(capability) !== undefined,
      requires: capabilityRequires(capability),
      limits: capabilityLimits(capability),
      risk: capabilityRisk(capability)
    }));
  }

  private async readRunOrThrow(runId: string) {
    try {
      return await this.store.readRun(runId);
    } catch {
      throw runNotFound(runId);
    }
  }

  private async tryReadAgentReply(_runId: string): Promise<AgentReply | undefined> {
    return undefined;
  }

  private startBackgroundPlan(runId: string, plan: Plan): void {
    void (async () => {
      try {
        await this.executor.executePlan({ runId, plan });
      } catch (error) {
        await this.failRunAfterBackgroundError(runId, error);
      }
    })().catch(error => {
      console.error("runtime background plan recovery failed", error);
    });
  }

  private async failRunAfterBackgroundError(runId: string, error: unknown): Promise<void> {
    const run = await this.readRunOrThrow(runId);
    if (run.status === "queued") {
      await this.runManager.transitionRun({
        runId,
        to: "planning",
        reason: "background execution failed before planning",
        source: "orchestrator"
      });
      await this.transitionFailedIfAllowed(runId, error);
      return;
    }
    if (run.status === "running" || run.status === "paused") {
      const collecting = await this.runManager.transitionRun({
        runId,
        to: "collecting_evidence",
        reason: "background execution failed",
        source: "orchestrator"
      });
      if (!collecting.accepted) {
        return;
      }
    }
    await this.transitionFailedIfAllowed(runId, error);
  }

  private async transitionFailedIfAllowed(runId: string, error: unknown): Promise<void> {
    const current = await this.readRunOrThrow(runId);
    if (current.status !== "planning" && current.status !== "collecting_evidence") {
      return;
    }
    await this.runManager.transitionRun({
      runId,
      to: "failed",
      reason: error instanceof Error ? error.message : "background execution failed",
      source: "orchestrator"
    });
  }
}

const P0_CAPABILITIES: CapabilityName[] = [
  "flash",
  "push",
  "watch_serial",
  "wait_adb",
  "shell_exec",
  "check_process",
  "collect_logs",
  "save_snapshot"
];

function capabilityRisk(capability: CapabilityName): CapabilityStatus["risk"] {
  return capability === "flash" || capability === "push" || capability === "shell_exec" ? "medium" : "low";
}

function capabilityRequires(capability: CapabilityName): CapabilityStatus["requires"] {
  if (capability === "flash") {
    return { connection: "fastboot" };
  }
  if (capability === "watch_serial") {
    return { connection: "serial" };
  }
  if (capability === "save_snapshot") {
    return { connection: "evidence_store" };
  }
  return { connection: "adb" };
}

function capabilityLimits(capability: CapabilityName): CapabilityStatus["limits"] {
  const defaultTimeouts: Record<CapabilityName, number> = {
    flash: 300,
    push: 60,
    watch_serial: 180,
    wait_adb: 180,
    shell_exec: 60,
    check_process: 30,
    collect_logs: 120,
    save_snapshot: 30
  };
  return {
    default_timeout_sec: defaultTimeouts[capability],
    max_duration_sec: capability === "watch_serial" ? 600 : defaultTimeouts[capability]
  };
}

function artifactInvalid(input: ValidateArtifactInput, reason: string): ValidateArtifactRejectedResponse {
  return {
    status: "artifact_invalid",
    target: input.target,
    reasons: [reason],
    missing_info: [],
    suggested_next: "Provide a readable local artifact file path."
  };
}

function elapsedSec(createdAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(createdAt).getTime()) / 1000);
}

function lastSeq(events: RunEvent[], fallback: number): number {
  return events.length === 0 ? fallback : events[events.length - 1]!.seq;
}
