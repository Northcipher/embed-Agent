import type { RunState, RunRecord, ValidateRequest, ValidateResponse, Plan } from "@embed-agent/contracts";
import type { EventBus } from "./event-bus.js";
import type { StepQueue } from "./step-queue.js";
import type { StepExecutor } from "./step-executor.js";

export class RunManager {
  private runs: Map<string, RunRecord> = new Map();
  private eventSeq = 0;

  constructor(
    private eventBus: EventBus,
    private runStore: { create(r: RunRecord): Promise<void>; update(id: string, p: Partial<RunRecord>): Promise<void>; get(id: string): Promise<RunRecord | null> },
    private targetManager: { preflight(tid: string, transports: string[], ap: string): Promise<{ all_passed: boolean }>; isBusy(s: unknown): boolean },
    private stepQueue: StepQueue,
    private stepExecutor: StepExecutor,
    private replyGenerator?: { generateMinimal(rid: string, reason: string): Promise<{ status: string; summary: string }> },
  ) {}

  private nextSeq(): number { return ++this.eventSeq; }
  private emit(type: string, runId: string, summary: string, payload: Record<string, unknown> = {}): void {
    this.eventBus.emit({ type, run_id: runId, seq: this.nextSeq(), time: new Date().toISOString(), source: "run_manager", summary, payload });
  }

  async createRun(request: ValidateRequest): Promise<ValidateResponse> {
    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();
    const run: RunRecord = {
      run_id: runId, session_id: "default", state: "planning", target_id: request.target,
      artifact: { path: request.artifact.path, type: request.artifact.type },
      elapsed_sec: 0, last_event_seq: 0, evidence_root: `.embed-agent/runs/${runId}`,
      created_at: now, started_at: now,
    };
    await this.runStore.create(run);
    this.runs.set(runId, run);
    this.emit("run_started", runId, "Run created");
    return { status: "accepted", run_id: runId, state: "planning", evidence_path: run.evidence_root };
  }

  async startExecution(runId: string, plan: Plan): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.stepQueue.load(plan.steps);
    run.state = "running";
    await this.runStore.update(runId, { state: "running" });
    this.emit("run_started", runId, "Execution started");
  }

  async finalize(runId: string, targetState: "completed" | "failed" | "cancelled", failureReason?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    run.state = "finalizing";
    await this.runStore.update(runId, { state: "finalizing" });

    if (failureReason) {
      run.failure_reason = failureReason;
    }

    // Generate result via Reply
    let status = targetState;
    let summary = failureReason ?? `Run ${targetState}`;
    if (this.replyGenerator) {
      const reply = await this.replyGenerator.generateMinimal(runId, failureReason ?? `Run ${targetState}`);
      status = reply.status as "completed" | "failed" | "cancelled";
      summary = reply.summary;
    }

    this.emit("result_ready", runId, summary, { status, summary });

    run.state = status as RunState;
    run.ended_at = new Date().toISOString();
    await this.runStore.update(runId, { state: run.state, ended_at: run.ended_at, failure_reason: run.failure_reason });

    this.emit(`run_${status}`, runId, summary);
  }

  async pause(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.state !== "running") return;
    this.stepExecutor.interrupt();
    this.stepQueue.pause();
    run.state = "paused";
    await this.runStore.update(runId, { state: "paused" });
    this.emit("run_paused", runId, "Paused");
  }

  async resume(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.state !== "paused") return;
    this.stepQueue.resume();
    run.state = "running";
    await this.runStore.update(runId, { state: "running" });
    this.emit("run_resumed", runId, "Resumed");
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.stepExecutor.interrupt();
    this.stepQueue.clear();
    await this.finalize(runId, "cancelled", reason);
  }

  getRun(runId: string): RunRecord | undefined { return this.runs.get(runId); }
  getState(runId: string): RunState | undefined { return this.runs.get(runId)?.state; }
}
