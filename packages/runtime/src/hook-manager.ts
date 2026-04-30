import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execFileP = promisify(execFile);

export type HookPoint =
  | "PreRunStart"
  | "PostRunEnd"
  | "PreStepExecute"
  | "PostStepComplete"
  | "PostStepFailed"
  | "OnStopDecision"
  | "OnFinalizing";

export interface HookConfig {
  name: string;
  on: HookPoint;
  match?: Record<string, string>;
  command: string;
  timeout: number;
}

export interface HookResult {
  decision?: "block" | "retry" | "continue";
  reason?: string;
  stdout?: string;
  stderr?: string;
}

// Hook points that allow returning a decision
const DECISION_POINTS: HookPoint[] = ["PreRunStart", "PreStepExecute", "OnStopDecision"];

export class HookManager {
  private hooks: HookConfig[];

  constructor(hooks: HookConfig[] = []) {
    this.hooks = hooks;
  }

  async execute(point: HookPoint, ctx: Record<string, unknown>): Promise<HookResult> {
    const matching = this.hooks.filter(h => h.on === point && this.matches(h.match, ctx));

    for (const hook of matching) {
      const result = await this.runHook(hook, ctx);
      if (DECISION_POINTS.includes(point) && result.decision) {
        return result; // first decision wins
      }
    }

    return {};
  }

  private matches(match: Record<string, string> | undefined, ctx: Record<string, unknown>): boolean {
    if (!match) return true;
    for (const [k, v] of Object.entries(match)) {
      if (ctx[k] !== v) return false;
    }
    return true;
  }

  private async runHook(hook: HookConfig, ctx: Record<string, unknown>): Promise<HookResult> {
    // Security: validate command is a script path, not inline shell
    await this.validateCommand(hook.command);

    try {
      const args = [JSON.stringify(ctx)];
      const { stdout, stderr } = await execFileP(hook.command, args, {
        timeout: hook.timeout * 1000,
        maxBuffer: 1024 * 1024,
      });

      const output = stdout.trim();
      // Only decision-capable hooks can return a decision
      if (DECISION_POINTS.includes(hook.on) && output) {
        try {
          const parsed = JSON.parse(output) as HookResult;
          return { stdout, stderr, ...parsed };
        } catch {
          return { stdout, stderr };
        }
      }

      return { stdout, stderr };
    } catch (e) {
      const err = e as { code?: string; stderr?: string };
      // Don't block on hook failure — return the error for audit
      const msg = err.code === "ENOENT" ? `Hook script not found: ${hook.command}` : (err.stderr ?? `Hook failed: ${(e as Error).message}`);
      return { stderr: msg };
    }
  }

  private async validateCommand(command: string): Promise<void> {
    // Must be an absolute or relative file path — no spaces or shell metacharacters
    if (!/^\.?\/|^\//.test(command) || /[;&|`$(){}\\]/.test(command)) {
      throw new Error(`Hook command must be a file path, got: ${command}`);
    }

    // Verify the file exists and is readable
    await fs.access(command, fs.constants.R_OK);
  }
}
