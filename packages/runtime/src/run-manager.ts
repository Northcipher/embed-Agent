import type { RunState, RunRecord, ValidateRequest, ValidateResponse, Step, Plan } from "@embed-agent/contracts";
import type { EventBus } from "./event-bus.js";
import type { StepQueue } from "./step-queue.js";
import type { StepExecutor } from "./step-executor.js";

export class RunManager {
  private runs: Map<string, RunRecord> = new Map();

  constructor(
    private eventBus: EventBus,
    private runStore: { create(r: RunRecord): Promise<void>; update(id: string, p: Partial<RunRecord>): Promise<void>; get(id: string): Promise<RunRecord | null> },
    private targetManager: { preflight(tid: string, transports: string[], ap: string): Promise<{ all_passed: boolean }>; isBusy(s: unknown): boolean },
    private stepQueue: StepQueue,
    private stepExecutor: StepExecutor,
  ) {}

  async createRun(request: ValidateRequest): Promise<ValidateResponse> {
    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();

    const run: RunRecord = {
      run_id: runId, session_id: "default", state: "planning", target_id: request.target,
      artifact: { path: request.artifact.path, type: request.artifact.type },
      elapsed_sec: 0, last_event_seq: 0,
      evidence_root: `.embed-agent/runs/${runId}`,
      created_at: now, started_at: now,
    };

    await this.runStore.create(run);
    this.runs.set(runId, run);
    this.eventBus.emit({ type: "run_started", run_id: runId, seq: 1, time: now, source: "run_manager", summary: "Run created", payload: {} });
    return { status: "accepted", run_id: runId, state: "planning", evidence_path: run.evidence_root };
  }

  async startExecution(runId: string, plan: Plan): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    this.stepQueue.load(plan.steps);
    run.state = "running";
    await this.runStore.update(runId, { state: "running" });
    this.eventBus.emit({ type: "run_started", run_id: runId, seq: 2, time: new Date().toISOString(), source: "run_manager", summary: "Execution started", payload: {} });
  }

  async pause(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.state !== "running") return;
    this.stepExecutor.interrupt();
    this.stepQueue.pause();
    run.state = "paused";
    await this.runStore.update(runId, { state: "paused" });
    this.eventBus.emit({ type: "run_paused", run_id: runId, seq: 99, time: new Date().toISOString(), source: "run_manager", summary: "Paused", payload: {} });
  }

  async resume(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.state !== "paused") return;
    this.stepQueue.resume();
    run.state = "running";
    await this.runStore.update(runId, { state: "running" });
    this.eventBus.emit({ type: "run_resumed", run_id: runId, seq: 100, time: new Date().toISOString(), source: "run_manager", summary: "Resumed", payload: {} });
  }

  async cancel(runId: string, _reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.stepExecutor.interrupt();
    this.stepQueue.clear();
    // In full version: finalizing → Reply → result_ready → cancelled
    run.state = "cancelled";
    await this.runStore.update(runId, { state: "cancelled", ended_at: new Date().toISOString() });
    this.eventBus.emit({ type: "run_cancelled", run_id: runId, seq: 999, time: new Date().toISOString(), source: "run_manager", summary: "Cancelled", payload: {} });
  }

  getRun(runId: string): RunRecord | undefined { return this.runs.get(runId); }
  getState(runId: string): RunState | undefined { return this.runs.get(runId)?.state; }
}
