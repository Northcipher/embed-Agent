import type { PublicErrorCode, RunEvent, RunState } from "@artifact-validation/contracts";
import { type AppendEventInput, FileStore, type StoredRun } from "@artifact-validation/file-store";
import { canTransitionRunState, validateInitialRunState } from "./state-machine.js";

export type RunManagerOptions = {
  store: FileStore;
  now?: () => Date;
};

export type CreateManagedRunInput = {
  runId: string;
  initialState?: RunState;
  request?: unknown;
  targetProfile?: unknown;
  inferredCapabilities?: unknown;
};

export type TransitionRunInput = {
  runId: string;
  to: RunState;
  reason: string;
  source?: AppendEventInput["source"];
};

export type RejectedRuntimeAction = {
  accepted: false;
  error_code: PublicErrorCode;
  message: string;
};

export type CreateManagedRunResult =
  | {
      accepted: true;
      run: StoredRun;
      event: RunEvent;
    }
  | RejectedRuntimeAction;

export type TransitionRunResult =
  | {
      accepted: true;
      run: StoredRun;
      events: RunEvent[];
    }
  | RejectedRuntimeAction;

export class RunManager {
  private readonly store: FileStore;

  private readonly now: () => Date;

  private readonly transitionQueues = new Map<string, Promise<void>>();

  constructor(options: RunManagerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async createRun(input: CreateManagedRunInput): Promise<CreateManagedRunResult> {
    const initialState = input.initialState ?? "queued";
    if (!validateInitialRunState(initialState)) {
      return rejected("invalid_request", `initial state ${initialState} is not allowed`);
    }

    const run = await this.store.createRun({
      run_id: input.runId,
      status: initialState,
      request: input.request,
      targetProfile: input.targetProfile,
      inferredCapabilities: input.inferredCapabilities
    });
    const event = await this.store.appendEvent(input.runId, {
      time: this.isoNow(),
      elapsed_sec: 0,
      type: "run_created",
      severity: "info",
      source: "run_manager",
      summary: `run ${input.runId} created`,
      payload: {
        state: initialState
      }
    });

    return { accepted: true, run: await this.store.readRun(input.runId), event };
  }

  async transitionRun(input: TransitionRunInput): Promise<TransitionRunResult> {
    return this.withRunTransition(input.runId, () => this.transitionRunSerial(input));
  }

  private async transitionRunSerial(input: TransitionRunInput): Promise<TransitionRunResult> {
    const current = await this.store.readRun(input.runId);
    if (!canTransitionRunState(current.status, input.to)) {
      return rejected("invalid_request", `cannot transition run ${input.runId} from ${current.status} to ${input.to}`);
    }

    const stateChanged = await this.store.appendEvent(input.runId, {
      time: this.isoNow(),
      elapsed_sec: elapsedSec(current.created_at, this.now()),
      type: "state_changed",
      severity: input.to === "failed" || input.to === "cancelled" ? "warning" : "info",
      source: input.source ?? "run_manager",
      summary: `run state changed from ${current.status} to ${input.to}`,
      payload: {
        from: current.status,
        to: input.to,
        reason: input.reason
      }
    });

    const events = [stateChanged];
    const terminalEvent = await this.appendTerminalEventIfNeeded(input.runId, input.to, input.reason, current.created_at);
    if (terminalEvent !== undefined) {
      events.push(terminalEvent);
    }

    const runAfterEvents = await this.store.readRun(input.runId);
    const updated = await this.store.writeRun({ ...runAfterEvents, status: input.to });

    return { accepted: true, run: updated, events };
  }

  private async withRunTransition<T>(runId: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.transitionQueues.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(transition);
    const queue = result.then(
      () => undefined,
      () => undefined
    );
    this.transitionQueues.set(runId, queue);
    try {
      return await result;
    } finally {
      if (this.transitionQueues.get(runId) === queue) {
        this.transitionQueues.delete(runId);
      }
    }
  }

  private async appendTerminalEventIfNeeded(
    runId: string,
    state: RunState,
    reason: string,
    createdAt: string
  ): Promise<RunEvent | undefined> {
    const terminalEventType = terminalRunEventType(state);
    if (terminalEventType === undefined) {
      return undefined;
    }

    return this.store.appendEvent(runId, {
      time: this.isoNow(),
      elapsed_sec: elapsedSec(createdAt, this.now()),
      type: terminalEventType,
      severity: state === "completed" ? "info" : "warning",
      source: "run_manager",
      summary: `run ${state}`,
      payload: { reason }
    });
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function terminalRunEventType(state: RunState): RunEvent["type"] | undefined {
  if (state === "completed") {
    return "run_completed";
  }
  if (state === "failed") {
    return "run_failed";
  }
  if (state === "cancelled") {
    return "run_cancelled";
  }
  return undefined;
}

function elapsedSec(createdAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(createdAt).getTime()) / 1000);
}

function rejected(error_code: PublicErrorCode, message: string): RejectedRuntimeAction {
  return {
    accepted: false,
    error_code,
    message
  };
}
