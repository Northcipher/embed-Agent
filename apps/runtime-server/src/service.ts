import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { CapabilityAdapterRegistry } from "@artifact-validation/adapters";
import {
  AgentReplySchema,
  type AgentReply,
  type CapabilityName,
  type CapabilityStatus,
  type CancelRunResponse,
  type EventType,
  type GetEvidenceResponse,
  type GetRunEventsResponse,
  type GetRunResultResponse,
  type GetTargetCapabilitiesResponse,
  type InterveneRunInput,
  type InterveneRunResponse,
  type ObserverIntent,
  type Plan,
  type RunEvent,
  type RunState,
  type RunStatusResponse,
  type TargetProfile,
  type ValidateArtifactAcceptedResponse,
  type ValidateArtifactInput,
  ValidateArtifactInputSchema,
  type ValidateArtifactRejectedResponse
} from "@artifact-validation/contracts";
import { FileStore, type StoredRun } from "@artifact-validation/file-store";
import { isTerminalRunState, PlanExecutor, RunManager } from "@artifact-validation/runtime-core";
import { RuntimeHttpError, resourceNotFound, runNotFound, unsupportedAction } from "./errors.js";
import { buildTargetProfileMap, inferTargetCapabilities } from "./target-profiles.js";

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

export type RuntimeReplyGeneratorInput = {
  runId: string;
  runDir: string;
  finalStatus: AgentReply["status"];
  evidencePath: string;
  evidenceRefs: string[];
  requestSummary: Record<string, unknown>;
  run: Record<string, unknown>;
  eventSummary: Array<Record<string, unknown>>;
  evidenceIndex: unknown;
  observerNotes: unknown[];
};

export type RuntimeReplyGeneratorResult = {
  status: "generated" | "fallback";
  reply: AgentReply;
  reasons?: string[];
  brain_call?: string;
};

export type RuntimeReplyGenerator = {
  generate(input: RuntimeReplyGeneratorInput): Promise<RuntimeReplyGeneratorResult>;
};

export type RuntimeObserverInput = {
  runId: string;
  runDir: string;
  run: Record<string, unknown>;
  targetState: Record<string, unknown>;
  triggerEvent: RunEvent;
  recentEvents: RunEvent[];
  evidenceWindows: Array<{ ref: string; kind: string; text: string }>;
  remainingDurationSec: number;
  allowedFollowUpCapabilities: CapabilityName[];
};

export type RuntimeObserverResult =
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

export type RuntimeObserver = {
  observe(input: RuntimeObserverInput): Promise<RuntimeObserverResult>;
};

export type RuntimeServiceOptions = {
  rootDir: string;
  adapters: CapabilityAdapterRegistry;
  planFactory?: PlanFactory;
  taskPlanner?: RuntimeTaskPlanner;
  replyGenerator?: RuntimeReplyGenerator;
  observer?: RuntimeObserver;
  targetProfiles?: TargetProfile[];
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

  private readonly replyGenerator: RuntimeReplyGenerator | undefined;

  private readonly observer: RuntimeObserver | undefined;

  private readonly targetProfiles: Map<string, TargetProfile> | undefined;

  private readonly targetLocks = new Map<string, string>();

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
    this.replyGenerator = options.replyGenerator;
    this.observer = options.observer;
    this.targetProfiles = buildTargetProfileMap(options.targetProfiles);
    this.executePlansInline = options.executePlansInline ?? false;
    this.idFactory = options.idFactory ?? (() => `run-${randomUUID()}`);
  }

  async validateArtifact(input: ValidateArtifactInput): Promise<ValidateArtifactServiceResponse> {
    const targetProfile = this.resolveTargetProfile(input.target);
    if (this.targetProfiles !== undefined && targetProfile === undefined) {
      return targetNotFound(input.target);
    }
    const lockedRunId = await this.lockedRunIdForTarget(input.target);
    if (lockedRunId !== undefined) {
      return targetBusy(input.target, lockedRunId);
    }

    const artifactValidation = await this.validateArtifactFile(input, targetProfile);
    if (artifactValidation !== undefined) {
      return artifactValidation;
    }

    const runId = this.idFactory();
    const targetCapabilities = this.capabilityStatuses(input, targetProfile);
    const created = await this.runManager.createRun({
      runId,
      initialState: "planning",
      request: input,
      targetProfile,
      inferredCapabilities: targetCapabilities
    });
    if (!created.accepted) {
      throw new RuntimeHttpError(400, created.error_code, created.message);
    }
    this.targetLocks.set(input.target, runId);

    const plannerResult = await this.createPlanForRun(runId, created.run.evidence_path, input, targetCapabilities);
    if (plannerResult.status !== "planned" && plannerResult.status !== "no_plan") {
      await this.failPlanningRun(runId, plannerResult.reasons.join("; "));
      await this.writeFinalReply(await this.store.readRun(runId));
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
        const execution = await this.executor.executePlan({
          runId,
          plan,
          allowedCapabilities: availableCapabilityNames(targetCapabilities)
        });
        if (!execution.accepted) {
          await this.failPlanningRun(runId, execution.message);
          await this.writeFinalReply(await this.store.readRun(runId));
          return {
            status: "plan_rejected",
            run_id: runId,
            target: input.target,
            reasons: [execution.message],
            missing_info: [],
            suggested_next: "Fix the hand-written plan or planner output and retry."
          };
        }
        await this.processObserverTriggers(execution.run, execution.events);
        await this.writeFinalReply(execution.run);
      } else {
        this.startBackgroundPlan(runId, plan, targetCapabilities);
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
    const targetId = await this.targetIdForRun(runId);
    const terminal = isTerminalRunState(run.status);
    return {
      run_id: run.run_id,
      status: run.status,
      target: {
        ...(targetId === undefined ? {} : { target_id: targetId }),
        state: terminal ? "idle" : "busy",
        current_run_id: terminal ? null : run.run_id,
        updated_at: run.updated_at
      },
      elapsed_sec: elapsedSec(run.created_at, this.now()),
      last_event_seq: run.last_event_seq,
      evidence_path: run.evidence_path
    };
  }

  async getRunEvents(runId: string, options: { afterSeq: number; limit: number; types?: EventType[] }): Promise<GetRunEventsResponse> {
    await this.readRunOrThrow(runId);
    const events = await this.store.readEvents(runId, {
      afterSeq: options.afterSeq,
      limit: options.limit + 1,
      ...(options.types === undefined ? {} : { types: options.types })
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
      await this.writeFinalReply(run);
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
    await this.writeFinalReply(transitioned.run);
    return {
      run_id: runId,
      status: "cancelled",
      evidence_path: transitioned.run.evidence_path
    };
  }

  async getTargetCapabilities(target: string): Promise<GetTargetCapabilitiesResponse> {
    const targetProfile = this.resolveTargetProfile(target);
    if (this.targetProfiles !== undefined && targetProfile === undefined) {
      throw new RuntimeHttpError(404, "target_not_found", `target ${target} was not found`);
    }
    const lockedRunId = await this.lockedRunIdForTarget(target);
    return {
      target,
      runtime_state: {
        target_id: target,
        state: lockedRunId === undefined ? "idle" : "busy",
        current_run_id: lockedRunId ?? null
      },
      capabilities: this.capabilityStatuses(undefined, targetProfile)
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

  private async validateArtifactFile(
    input: ValidateArtifactInput,
    targetProfile: TargetProfile | undefined
  ): Promise<ValidateArtifactRejectedResponse | undefined> {
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
    if (targetProfile?.flash?.artifact_type !== undefined && input.artifact.type !== targetProfile.flash.artifact_type) {
      return artifactInvalid(
        input,
        `artifact type ${input.artifact.type} does not match target flash artifact_type ${targetProfile.flash.artifact_type}`
      );
    }
    return undefined;
  }

  private capabilityStatuses(input?: ValidateArtifactInput, targetProfile?: TargetProfile): CapabilityStatus[] {
    return inferTargetCapabilities({
      adapters: this.adapters,
      targetProfile,
      constraints: input?.constraints
    });
  }

  private resolveTargetProfile(target: string): TargetProfile | undefined {
    return this.targetProfiles?.get(target);
  }

  private async readRunOrThrow(runId: string) {
    try {
      return await this.store.readRun(runId);
    } catch {
      throw runNotFound(runId);
    }
  }

  private async tryReadAgentReply(runId: string): Promise<AgentReply | undefined> {
    return this.store.readAgentReply(runId);
  }

  private async targetIdForRun(runId: string): Promise<string | undefined> {
    const request = await this.store.readRunRequest(runId);
    const parsed = ValidateArtifactInputSchema.safeParse(request);
    return parsed.success ? parsed.data.target : undefined;
  }

  private async lockedRunIdForTarget(target: string): Promise<string | undefined> {
    const runId = this.targetLocks.get(target);
    if (runId === undefined) {
      return undefined;
    }
    try {
      const run = await this.store.readRun(runId);
      if (isTerminalRunState(run.status)) {
        this.targetLocks.delete(target);
        return undefined;
      }
      return runId;
    } catch {
      this.targetLocks.delete(target);
      return undefined;
    }
  }

  private async releaseTargetLockForRun(run: StoredRun): Promise<void> {
    if (!isTerminalRunState(run.status)) {
      return;
    }
    const target = await this.targetIdForRun(run.run_id);
    if (target !== undefined && this.targetLocks.get(target) === run.run_id) {
      this.targetLocks.delete(target);
    }
  }

  private startBackgroundPlan(runId: string, plan: Plan, targetCapabilities: CapabilityStatus[]): void {
    void (async () => {
      try {
        const execution = await this.executor.executePlan({
          runId,
          plan,
          allowedCapabilities: availableCapabilityNames(targetCapabilities)
        });
        if (execution.accepted) {
          await this.processObserverTriggers(execution.run, execution.events);
          await this.writeFinalReply(execution.run);
        } else {
          const run = await this.store.readRun(runId);
          await this.writeFinalReply(run);
        }
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
    if (isTerminalRunState(current.status)) {
      await this.writeFinalReply(current);
      return;
    }
    if (current.status !== "planning" && current.status !== "collecting_evidence") {
      return;
    }
    await this.runManager.transitionRun({
      runId,
      to: "failed",
      reason: error instanceof Error ? error.message : "background execution failed",
      source: "orchestrator"
    });
    await this.writeFinalReply(await this.store.readRun(runId));
  }

  private async processObserverTriggers(run: StoredRun, events: RunEvent[]): Promise<void> {
    if (this.observer === undefined) {
      return;
    }
    const triggerEvents = events.filter(shouldTriggerObserver).slice(0, MAX_OBSERVER_TRIGGERS_PER_EXECUTION);
    if (triggerEvents.length === 0) {
      return;
    }

    for (const triggerEvent of triggerEvents) {
      const recentEvents = await this.store.readEvents(run.run_id, {
        afterSeq: Math.max(0, triggerEvent.seq - 20),
        limit: 20
      });
      try {
        const result = await this.observer.observe({
          runId: run.run_id,
          runDir: run.evidence_path,
          run: {
            run_id: run.run_id,
            state: run.status,
            elapsed_sec: elapsedSec(run.created_at, this.now())
          },
          targetState: {
            state: run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? "idle" : "busy"
          },
          triggerEvent,
          recentEvents,
          evidenceWindows: [],
          remainingDurationSec: 0,
          allowedFollowUpCapabilities: ["collect_logs", "save_snapshot"]
        });
        await this.appendObserverEvent(run, triggerEvent, result);
      } catch (error) {
        await this.appendObserverEvent(run, triggerEvent, {
          status: "rejected",
          reasons: [error instanceof Error ? error.message : "Observer failed"],
          fallback_intent: {
            intent: "continue",
            reason: "Observer failed; Runtime used default fallback.",
            confidence: 0,
            requested_actions: [],
            report_to_caller: false
          },
          brain_call: "observer-unavailable"
        });
      }
    }
  }

  private async appendObserverEvent(run: StoredRun, triggerEvent: RunEvent, result: RuntimeObserverResult): Promise<void> {
    const accepted = result.status === "accepted";
    const intent = accepted ? result.intent : result.fallback_intent;
    const eventType = accepted && intent.intent === "intermediate_observation" ? "intermediate_observation" : "observer_intent";
    await this.store.appendEvent(run.run_id, {
      time: this.now().toISOString(),
      elapsed_sec: elapsedSec(run.created_at, this.now()),
      type: eventType,
      severity: accepted && (intent.intent === "continue" || intent.intent === "intermediate_observation") ? "info" : "warning",
      source: "observer",
      summary: accepted ? `observer ${intent.intent}: ${intent.reason}` : `observer intent rejected: ${result.reasons.join("; ")}`,
      payload: {
        accepted,
        intent,
        brain_call: result.brain_call,
        trigger_event_seq: triggerEvent.seq,
        ...(result.status === "rejected" ? { reasons: result.reasons } : {})
      }
    });
  }

  private async writeFinalReply(run: StoredRun): Promise<void> {
    const finalStatus = replyStatusFromRunState(run.status);
    if (finalStatus === undefined) {
      return;
    }
    await this.releaseTargetLockForRun(run);
    if ((await this.store.readAgentReply(run.run_id)) !== undefined) {
      return;
    }
    if (this.replyGenerator === undefined) {
      await this.writeRuleBasedReply(run);
      return;
    }

    const index = await this.store.readEvidenceIndex(run.run_id);
    try {
      const result = await this.replyGenerator.generate(await this.buildReplyGeneratorInput(run, finalStatus, index));
      const reply = validateReplyForRun(result.reply, run, finalStatus, index.refs.map(ref => ref.ref));
      await this.store.writeAgentReply(run.run_id, reply);
    } catch {
      await this.writeRuleBasedReply(run);
    }
  }

  private async writeRuleBasedReply(run: StoredRun): Promise<void> {
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
      return;
    }
    const index = await this.store.readEvidenceIndex(run.run_id);
    const reply = AgentReplySchema.parse({
      run_id: run.run_id,
      status: run.status,
      summary: `run ${run.status}; review event stream and evidence refs for details`,
      confidence: 0.5,
      key_evidence: index.key_events.map(event => ({
        summary: event.summary,
        evidence_refs: event.evidence_refs
      })),
      suggested_next: "Review the referenced evidence and rerun validation with more context if needed.",
      evidence_path: run.evidence_path
    });
    await this.store.writeAgentReply(run.run_id, reply);
  }

  private async buildReplyGeneratorInput(
    run: StoredRun,
    finalStatus: AgentReply["status"],
    evidenceIndex: Awaited<ReturnType<FileStore["readEvidenceIndex"]>>
  ): Promise<RuntimeReplyGeneratorInput> {
    const events = await this.store.readEvents(run.run_id, {
      afterSeq: Math.max(0, run.last_event_seq - 50),
      limit: 50
    });
    const request = await this.store.readRunRequest(run.run_id);
    return {
      runId: run.run_id,
      runDir: run.evidence_path,
      finalStatus,
      evidencePath: run.evidence_path,
      evidenceRefs: evidenceIndex.refs.map(ref => ref.ref),
      requestSummary: summarizeRequest(request),
      run: {
        run_id: run.run_id,
        state: run.status,
        elapsed_sec: elapsedSec(run.created_at, this.now()),
        last_event_seq: run.last_event_seq
      },
      eventSummary: events.map(event => ({
        seq: event.seq,
        type: event.type,
        severity: event.severity,
        source: event.source,
        summary: event.summary,
        evidence_refs: event.evidence_refs ?? []
      })),
      evidenceIndex,
      observerNotes: []
    };
  }
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

function targetNotFound(target: string): ValidateArtifactRejectedResponse {
  return {
    status: "target_not_found",
    target,
    reasons: [`target ${target} was not found`],
    missing_info: ["target profile"],
    suggested_next: "Configure a target profile before validating artifacts for this target."
  };
}

function targetBusy(target: string, runId: string): ValidateArtifactRejectedResponse {
  return {
    status: "busy",
    target,
    reasons: [`target ${target} is busy with run ${runId}`],
    missing_info: [],
    suggested_next: "Wait for the current run to finish or cancel it before starting another validation."
  };
}

function availableCapabilityNames(capabilities: CapabilityStatus[]): CapabilityName[] {
  return capabilities.filter(capability => capability.available).map(capability => capability.name);
}

function elapsedSec(createdAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(createdAt).getTime()) / 1000);
}

function lastSeq(events: RunEvent[], fallback: number): number {
  return events.length === 0 ? fallback : events[events.length - 1]!.seq;
}

export function shouldTriggerObserver(event: RunEvent): boolean {
  if (event.type === "rule_matched") {
    return event.severity === "error" || event.severity === "warning";
  }
  return event.type === "step_failed" || event.type === "step_timeout";
}

const MAX_OBSERVER_TRIGGERS_PER_EXECUTION = 3;

function replyStatusFromRunState(state: RunState): AgentReply["status"] | undefined {
  if (state === "completed" || state === "failed" || state === "cancelled") {
    return state;
  }
  return undefined;
}

function validateReplyForRun(
  reply: AgentReply,
  run: StoredRun,
  finalStatus: AgentReply["status"],
  evidenceRefs: string[]
): AgentReply {
  const parsed = AgentReplySchema.parse(reply);
  if (parsed.run_id !== run.run_id) {
    throw new Error("reply run_id does not match current run");
  }
  if (parsed.status !== finalStatus) {
    throw new Error("reply status does not match final run state");
  }
  const availableEvidenceRefs = new Set(evidenceRefs);
  for (const item of parsed.key_evidence) {
    for (const ref of item.evidence_refs) {
      if (!availableEvidenceRefs.has(ref)) {
        throw new Error(`reply references missing evidence ref ${ref}`);
      }
    }
  }
  return parsed;
}

function summarizeRequest(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) {
    return {};
  }
  const context = isRecord(request.context) ? request.context : {};
  const artifact = isRecord(request.artifact) ? request.artifact : {};
  const summary: Record<string, unknown> = {};
  copyIfPresent(summary, context, "task");
  copyIfPresent(summary, context, "expected");
  copyIfPresent(summary, context, "what_changed");
  copyIfPresent(summary, context, "concerns");
  copyIfPresent(summary, request, "target");
  if (typeof artifact.type === "string") {
    summary.artifact_type = artifact.type;
  }
  return summary;
}

function copyIfPresent(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
