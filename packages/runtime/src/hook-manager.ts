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

interface AuditEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

export class HookManager {
  private hooks: HookConfig[];
  private eb: AuditEmitter | undefined;

  constructor(hooks: HookConfig[] = [], eb?: AuditEmitter) {
    this.hooks = hooks;
    this.eb = eb;
  }

  async execute(point: HookPoint, ctx: Record<string, unknown>): Promise<HookResult> {
    const matching = this.hooks.filter(h => h.on === point && this.matches(h.match, ctx));

    for (const hook of matching) {
      const startTime = Date.now();
      let result: HookResult;
      try {
        result = await this.runHook(hook, ctx);
      } catch {
        result = { stderr: "Hook execution threw" };
      }

      // Always emit hook_executed audit event
      this.eb?.emit({
        type: "hook_executed",
        source: "hook_manager",
        summary: `Hook "${hook.name}" on ${point}: ${result.decision ?? "proceed"}`,
        payload: {
          hook_name: hook.name,
          point,
          decision: result.decision,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: Date.now() - startTime,
        },
      });

      if (DECISION_POINTS.includes(point)) {
        return result; // first matching hook's result for decision points
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
    const scriptPath = await this.validateCommand(hook.command);

    // Interpolate {{variables}} from ctx
    const args = [JSON.stringify(ctx)];

    try {
      const { stdout, stderr } = await execFileP(scriptPath, args, {
        timeout: hook.timeout * 1000,
        maxBuffer: 1024 * 1024,
      });

      const output = stdout.trim();
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
      // Proceed on failure — never throw
      const msg = err.code === "ENOENT"
        ? `Hook script not found: ${hook.command}`
        : (err.stderr ?? `Hook failed: ${(e as Error).message}`);
      return { stderr: msg };
    }
  }

  /**
   * Validate hook command: must be a script file path.
   * Reject inline shell (pipes, redirects, command separators, backticks).
   * Scripts with arguments (e.g., "./script.sh --flag") are allowed.
   */
  private async validateCommand(command: string): Promise<string> {
    // Extract the script path (first token that looks like a path)
    const match = command.match(/^(\.\/\S+|\/\S+)/);
    const scriptPath = match?.[1];
    if (!scriptPath) {
      throw new Error(`Hook command must start with a file path, got: ${command}`);
    }

    // Reject shell metacharacters in the remainder of the command
    const remainder = command.slice(scriptPath.length);
    if (/[;&|`$(){}]/.test(remainder)) {
      throw new Error(`Hook command contains shell metacharacters: ${command}`);
    }

    // Verify the script file exists and is readable
    await fs.access(scriptPath, fs.constants.R_OK);
    return scriptPath;
  }
}
