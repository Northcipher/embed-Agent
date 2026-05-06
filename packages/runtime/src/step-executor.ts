import type { Step } from "./step-queue.js";
import type { Connection, ExecResult } from "@embed-agent/tools";
import type { HookManager, HookPoint } from "./hook-manager.js";

interface EventEmitter { emit(e: Record<string, unknown>): Promise<void>; }

interface ConnectionResolver {
  getForStep(target: { target_id: string; connections: Record<string, unknown> }, action: string, capability: string): Connection | null;
  isShellCommandAllowed?(command: string): boolean;
}

interface OutputPipeLike {
  feedStream(chunk: string): Promise<void>;
  feedExec(stdout: string, stderr: string, exitCode: number): Promise<void>;
  flush(): Promise<void>;
  disableSilence?(): void;
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

const STREAM_POLL_MS = 250;

function splitCommandPair(command: string | undefined): [string | undefined, string | undefined] {
  if (!command) return [undefined, undefined];
  const separator = command.lastIndexOf(":");
  if (separator <= 0 || separator === command.length - 1) return [undefined, undefined];
  return [command.slice(0, separator), command.slice(separator + 1)];
}

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
    if (preResult.decision === "retry") {
      await this.eb.emit({
        type: "observation", run_id: this.runId, source: "step_executor", severity: "info",
        summary: `Step retry requested by hook: ${preResult.reason ?? "no reason"}`,
        payload: { step_id: step.id },
      });
      // Return non-completed to trigger retry logic in executeWithRetry
      return { completed: false, error: `Hook retry: ${preResult.reason ?? "no reason"}`, failureType: "transient" };
    }

    // 2. Get Connection
    const conn = this.cm.getForStep(this.target, step.action, step.capability);
    if (!conn) {
      return { completed: false, error: `No connection for action=${step.action} capability=${step.capability}` };
    }

    // 2b. Connect with retry (transient connection failures are retryable)
    let connectAttempt = 0;
    const maxConnectRetries = this.retryConfig.maxRetries;
    while (true) {
      try {
        await conn.connect();
        break;
      } catch (e) {
        connectAttempt++;
        if (connectAttempt > maxConnectRetries || !this.retryConfig.retryable.includes("connection_lost")) {
          return { completed: false, error: `Connection failed after ${connectAttempt} attempts: ${(e as Error).message}`, failureType: "connection_lost" };
        }
        const delay = (this.retryConfig.intervals[connectAttempt - 1] ?? this.retryConfig.intervals[this.retryConfig.intervals.length - 1]!) * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // 3. Execute with retry
    await this.eb.emit({
      type: "step_started", run_id: this.runId, step_id: step.id, source: "step_executor",
      summary: `Step ${step.id} started`, payload: { capability: step.capability, action: step.action },
    });

    try {
      const result = await this.executeWithRetry(step, conn);

      if (this._interrupted) {
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
    if (!pipe) {
      console.warn(`[StepExecutor] No pipeFactory configured — step ${step.id} runs blind (no output capture, no rule detection, no evidence collection)`);
      this.eb.emit({
        type: "observation", run_id: this.runId, source: "step_executor", severity: "warning",
        summary: `Step ${step.id} executing without output pipe — diagnostics unavailable`,
        payload: { step_id: step.id },
      });
    }
    if (pipe) pipe.setConnection?.(conn);
    const timeout = step.timeout_sec + this._timeoutExtension;

    try {
      switch (step.action) {
        case "exec": {
          if (!conn.exec) return { success: false, error: "exec not supported", failureType: "unsupported" };
          // Shell command whitelist enforcement — covers device commands via ADB/SSH.
          // local_exec has its own local whitelist via LocalConnection.
          if (step.command && step.capability !== "local_exec" && this.cm.isShellCommandAllowed) {
            const allowed = this.cm.isShellCommandAllowed(step.command);
            if (!allowed) return { success: false, error: `Command not whitelisted: ${step.command}`, failureType: "security_blocked" };
          }
          const result = await conn.exec(step.command ?? "true", timeout);
          if (pipe) await pipe.feedExec(result.stdout, result.stderr, result.exit_code);
          return result.exit_code === 0
            ? { success: true }
            : { success: false, error: `exit code ${result.exit_code}`, failureType: "non_zero_exit" };
        }

        case "stream": {
          if (!conn.stream) return { success: false, error: "stream not supported", failureType: "unsupported" };
          const streamStart = Date.now();
          let lastSample = Date.now();
          const sampleInterval = step.observe?.sampling_commands?.length
            ? (step.observe.interval ?? 60) * 1000
            : 0;
          const iterator = conn.stream(timeout)[Symbol.asyncIterator]();
          let pendingNext: Promise<IteratorResult<string>> | null = null;

          try {
            while (!this._interrupted) {
              // A stream step is an observation window. Reaching the time budget
              // means we collected enough evidence; it is not a device failure.
              const effectiveTimeout = (step.timeout_sec + this._timeoutExtension) * 1000;
              if (Date.now() - streamStart > effectiveTimeout) break;

              pendingNext ??= iterator.next();
              const remaining = Math.max(1, effectiveTimeout - (Date.now() - streamStart));
              const next = await this.waitForStreamLine(pendingNext, Math.min(remaining, STREAM_POLL_MS));
              if (next === "timeout") continue;
              pendingNext = null;
              if (next.done) break;

              if (pipe) await pipe.feedStream(next.value + "\n");
              // Active sampling: periodically run observe.sampling_commands
              if (sampleInterval > 0 && Date.now() - lastSample >= sampleInterval) {
                lastSample = Date.now();
                for (const cmd of (step.observe?.sampling_commands ?? [])) {
                  if (conn.exec && (this.cm.isShellCommandAllowed?.(cmd) ?? true)) {
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
          } finally {
            if (pendingNext) {
              pendingNext.catch(() => {});
              try { await conn.disconnect(); } catch { /* executeStep finalizer also disconnects */ }
              const returnResult = iterator.return?.();
              if (returnResult) returnResult.catch(() => {});
            }
            await pipe?.flush();
            pipe?.disableSilence?.();
          }
          if (this._interrupted) return { success: false, error: "interrupted" };
          return { success: true };
        }

        case "push": {
          if (!conn.push) return { success: false, error: "push not supported", failureType: "unsupported" };
          const [commandSrc, commandDst] = splitCommandPair(step.command);
          const src = step.src ?? commandSrc;
          const dst = step.dst ?? commandDst;
          if (!src || !dst) return { success: false, error: "push requires src:dst (or step.src + step.dst)", failureType: "invalid_args" };
          await conn.push(src, dst, timeout);
          return { success: true };
        }

        case "flash": {
          if (!conn.flash) return { success: false, error: "flash not supported", failureType: "unsupported" };
          const [commandImage, commandPartition] = splitCommandPair(step.command);
          const image = step.image ?? commandImage;
          const partition = step.partition ?? commandPartition;
          if (!image || !partition) return { success: false, error: "flash requires image:partition (or step.image + step.partition)", failureType: "invalid_args" };
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

  private async waitForStreamLine(
    pendingNext: Promise<IteratorResult<string>>,
    timeoutMs: number,
  ): Promise<IteratorResult<string> | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pendingNext,
        new Promise<"timeout">(resolve => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
