import type { Step } from "./step-queue.js";
import type { Connection, ExecResult } from "@embed-agent/tools";
import type { HookManager, HookPoint } from "./hook-manager.js";

interface EventEmitter { emit(e: Record<string, unknown>): Promise<void>; }

interface ConnectionResolver {
  getForStep(target: { target_id: string; connections: Record<string, unknown> }, action: string, capability: string): Connection | null;
}

interface OutputPipeLike {
  feedStream(chunk: string): Promise<void>;
  feedExec(stdout: string, stderr: string, exitCode: number): Promise<void>;
  flush(): Promise<void>;
  setConnection?(conn: { state(): string }): void;
}

export interface RetryConfig {
  maxRetries: number;
  intervals: number[];
  retryable: string[];
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  intervals: [2, 5, 10],
  retryable: ["timeout", "connection_lost", "device_not_ready", "transient"],
};

export class StepRetryBreaker {
  private consecutive: { type: string; count: number } | null = null;

  shouldRetry(failureType: string, maxSame = 3): boolean {
    if (this.consecutive?.type === failureType) {
      this.consecutive.count++;
      return this.consecutive.count < maxSame;
    }
    this.consecutive = { type: failureType, count: 1 };
    return true;
  }

  reset(): void { this.consecutive = null; }
}

export class StepExecutor {
  private retryBreaker = new StepRetryBreaker();
  private _interrupted = false;
  private _timeoutExtension = 0;
  private retryConfig: RetryConfig;

  constructor(
    private runId: string,
    private target: { target_id: string; connections: Record<string, unknown> },
    private eb: EventEmitter,
    private hm: HookManager,
    private cm: ConnectionResolver,
    private pipeFactory?: (stepId: string) => OutputPipeLike | null,
    retryConfig?: Partial<RetryConfig>,
  ) {
    this.retryConfig = { ...DEFAULT_RETRY, ...retryConfig };
  }

  get interrupted(): boolean { return this._interrupted; }

  interrupt(): void { this._interrupted = true; }

  extendTimeout(seconds: number): void { this._timeoutExtension += seconds; }

  async executeStep(step: Step): Promise<{ completed: boolean; interrupted?: boolean; blocked?: boolean; error?: string; failureType?: string }> {
    this._interrupted = false;
    this._timeoutExtension = 0;

    // 1. PreStepExecute Hook
    const preResult = await this.hm.execute("PreStepExecute", {
      run_id: this.runId, step_id: step.id, capability: step.capability, command: step.command,
    });

    if (preResult.decision === "block") {
      await this.eb.emit({
        type: "run_paused", run_id: this.runId, source: "step_executor",
        summary: `Step blocked by PreStepExecute hook: ${preResult.reason ?? "no reason"}`,
        payload: { step_id: step.id, reason: preResult.reason },
      });
      return { completed: false, blocked: true, error: `Hook blocked: ${preResult.reason}` };
    }

    // 2. Get Connection
    const conn = this.cm.getForStep(this.target, step.action, step.capability);
    if (!conn) {
      return { completed: false, error: `No connection for action=${step.action} capability=${step.capability}` };
    }

    try {
      await conn.connect();
    } catch (e) {
      return { completed: false, error: `Connection failed: ${(e as Error).message}`, failureType: "connection_lost" };
    }

    // 3. Execute with retry
    await this.eb.emit({
      type: "step_started", run_id: this.runId, step_id: step.id, source: "step_executor",
      summary: `Step ${step.id} started`, payload: { capability: step.capability, action: step.action },
    });

    try {
      const result = await this.executeWithRetry(step, conn);

      if (this._interrupted) {
        await this.eb.emit({ type: "step_failed", run_id: this.runId, step_id: step.id, source: "step_executor", summary: "Step interrupted", payload: {} });
        await this.hm.execute("PostStepFailed", { run_id: this.runId, step_id: step.id, reason: "interrupted" });
        return { completed: false, interrupted: true };
      }

      if (!result.success) {
        await this.eb.emit({ type: "step_failed", run_id: this.runId, step_id: step.id, source: "step_executor", summary: result.error ?? "unknown", payload: { failure_type: result.failureType } });
        await this.hm.execute("PostStepFailed", { run_id: this.runId, step_id: step.id, reason: result.error });
        const errResult: { completed: boolean; interrupted?: boolean; error?: string; failureType?: string } = { completed: false };
        if (result.error) errResult.error = result.error;
        if (result.failureType) errResult.failureType = result.failureType;
        return errResult;
      }

      await this.eb.emit({ type: "step_completed", run_id: this.runId, step_id: step.id, source: "step_executor", summary: `Step ${step.id} completed`, payload: {} });
      await this.hm.execute("PostStepComplete", { run_id: this.runId, step_id: step.id });
      return { completed: true };
    } finally {
      try { await conn.disconnect(); } catch (e) { console.error(`[StepExecutor] Disconnect failed:`, (e as Error).message); }
    }
  }

  private async executeWithRetry(
    step: Step,
    conn: Connection,
  ): Promise<{ success: boolean; error?: string; failureType?: string }> {
    const maxRetries = step.retry_policy?.max_retries ?? this.retryConfig.maxRetries;
    const intervals = step.retry_policy?.intervals_sec ?? this.retryConfig.intervals;
    let attempt = 0;

    while (attempt <= maxRetries) {
      if (this._interrupted) return { success: false, error: "interrupted" };

      const result = await this.runStep(step, conn);
      if (result.success) {
        this.retryBreaker.reset();
        return result;
      }

      const failureType = result.failureType ?? "unknown";

      // Non-retryable failures
      if (!this.retryConfig.retryable.includes(failureType)) {
        return result;
      }

      // CB2: same-cause consecutive failure detection
      if (!this.retryBreaker.shouldRetry(failureType)) {
        await this.eb.emit({
          type: "step_failed", run_id: this.runId, step_id: step.id, source: "step_executor",
          summary: `CB2: possible hardware issue — ${failureType} repeated`,
          payload: { failure_type: failureType },
        });
        return { success: false, error: `CB2 tripped: ${failureType} repeated`, failureType: "possible_hardware_issue" };
      }

      attempt++;
      if (attempt > maxRetries) return result;

      const delay = (intervals[attempt - 1] ?? intervals[intervals.length - 1]!) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }

    return { success: false, error: "max retries exceeded" };
  }

  private async runStep(
    step: Step,
    conn: Connection,
  ): Promise<{ success: boolean; error?: string; failureType?: string }> {
    const pipe = this.pipeFactory?.(step.id) ?? null;
    if (pipe) pipe.setConnection?.(conn);
    const timeout = step.timeout_sec + this._timeoutExtension;

    try {
      switch (step.action) {
        case "exec": {
          if (!conn.exec) return { success: false, error: "exec not supported", failureType: "unsupported" };
          const result = await conn.exec(step.command ?? "true", timeout);
          if (pipe) await pipe.feedExec(result.stdout, result.stderr, result.exit_code);
          return result.exit_code === 0
            ? { success: true }
            : { success: false, error: `exit code ${result.exit_code}`, failureType: "non_zero_exit" };
        }

        case "stream": {
          if (!conn.stream) return { success: false, error: "stream not supported", failureType: "unsupported" };
          const deadline = Date.now() + timeout * 1000;
          let lastSample = Date.now();
          const sampleInterval = (step.observe?.sampling_commands?.length ? 60_000 : 0); // sample every 60s

          for await (const line of conn.stream(timeout)) {
            if (this._interrupted) { await pipe?.flush(); break; }
            if (pipe) await pipe.feedStream(line + "\n");
            if (Date.now() > deadline) {
              await pipe?.flush();
              return { success: false, error: "stream timeout", failureType: "timeout" };
            }
            // Active sampling: periodically run observe.sampling_commands
            if (sampleInterval > 0 && Date.now() - lastSample >= sampleInterval) {
              lastSample = Date.now();
              for (const cmd of (step.observe?.sampling_commands ?? [])) {
                if (conn.exec) {
                  const r = await conn.exec(cmd, 10);
                  if (pipe) await pipe.feedExec(r.stdout, r.stderr, r.exit_code);
                  await this.eb.emit({
                    type: "observation", run_id: this.runId, source: "step_executor",
                    summary: `Sampling: ${cmd} (exit ${r.exit_code})`,
                    payload: { sampling_command: cmd, exit_code: r.exit_code },
                  });
                }
              }
            }
          }
          await pipe?.flush();
          return { success: true };
        }

        case "push": {
          if (!conn.push) return { success: false, error: "push not supported", failureType: "unsupported" };
          const [src, dst] = (step.command ?? ":").split(":");
          if (!src || !dst) return { success: false, error: "push requires src:dst", failureType: "invalid_args" };
          await conn.push(src, dst);
          return { success: true };
        }

        case "flash": {
          if (!conn.flash) return { success: false, error: "flash not supported", failureType: "unsupported" };
          const [image, partition] = (step.command ?? ":").split(":");
          if (!image || !partition) return { success: false, error: "flash requires image:partition", failureType: "invalid_args" };
          await conn.flash(image, partition);
          return { success: true };
        }

        case "wait": {
          if (!conn.exec) return { success: false, error: "wait not supported", failureType: "unsupported" };
          const result = await conn.exec(step.command ?? "true", timeout);
          if (pipe) await pipe.feedExec(result.stdout, result.stderr, result.exit_code);
          return result.exit_code === 0
            ? { success: true }
            : { success: false, error: `wait failed: exit ${result.exit_code}`, failureType: "non_zero_exit" };
        }

        default:
          return { success: false, error: `unknown action: ${(step as { action: string }).action}`, failureType: "invalid_args" };
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
        return { success: false, error: "timeout", failureType: "timeout" };
      }
      if (msg.includes("ECONNREFUSED") || msg.includes("disconnected")) {
        return { success: false, error: msg, failureType: "connection_lost" };
      }
      return { success: false, error: msg, failureType: "unknown" };
    }
  }
}
