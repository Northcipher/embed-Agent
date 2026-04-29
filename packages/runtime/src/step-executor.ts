import type { Step, Connection } from "@embed-agent/contracts";
import type { ConnectionManager } from "@embed-agent/tools";
import type { OutputPipe } from "@embed-agent/tools";
import type { StepQueue } from "./step-queue.js";

export class StepExecutor {
  private _interruptRequested = false;
  private currentStep: Step | null = null;

  constructor(
    private queue: StepQueue,
    private cm: ConnectionManager,
    private targetId: string,
    private outputPipeFactory: (step: Step) => OutputPipe,
  ) {}

  get interruptRequested(): boolean { return this._interruptRequested; }

  interrupt(): void { this._interruptRequested = true; }

  extendTimeout(_seconds: number): void {
    // Extend current step timeout. Implementation in full version.
  }

  async executeNext(targetProfile: { connections: Record<string, unknown> }): Promise<boolean> {
    const step = this.queue.next();
    if (!step) return false;

    this.currentStep = step;
    this._interruptRequested = false;

    const conn = this.getConnectionForStep(step, targetProfile);
    if (!conn) {
      return true; // capability missing, skip
    }

    await conn.connect();

    try {
      switch (step.action) {
        case "exec":
          if (conn.exec) {
            const result = await conn.exec(step.command ?? "", step.timeout);
            const op = this.outputPipeFactory(step);
            op.feedExec(result.stdout, result.stderr, result.exit_code);
          }
          break;
        case "stream":
          if (conn.stream) {
            const op = this.outputPipeFactory(step);
            for await (const chunk of conn.stream(step.timeout)) {
              if (this._interruptRequested) break;
              op.feedStream(chunk);
            }
          }
          break;
        case "push":
          if (conn.push && step.src && step.dst) {
            await conn.push(step.src, step.dst);
          }
          break;
        case "flash":
          if (conn.flash && step.image && step.partition) {
            await conn.flash(step.image, step.partition);
          }
          break;
      }
    } finally {
      await conn.disconnect();
    }

    return !this.queue.isEmpty;
  }

  private getConnectionForStep(step: Step, target: { connections: Record<string, unknown> }): Connection | null {
    const { action, capability } = step;
    if (action === "stream") return this.cm.getConnection(target as never, "serial");
    if (action === "flash") return this.cm.getConnection(target as never, "fastboot");
    if (capability === "push") return this.cm.getConnection(target as never, "adb") ?? this.cm.getConnection(target as never, "ssh");
    return this.cm.getConnection(target as never, "adb") ?? this.cm.getConnection(target as never, "ssh") ?? this.cm.getConnection(target as never, "local");
  }
}
