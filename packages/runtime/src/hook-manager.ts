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
  | "OnFinalizing"
  | "RuntimeStart";

export interface HookConfig {
  name: string;
  on: HookPoint;
  match?: Record<string, string>;
  command: string;
  timeout: number;
}

export interface HookResult {
  decision?: "block" | "retry" | "proceed";
  reason?: string;
  stdout?: string;
  stderr?: string;
}

// Per-HookPoint allowed decisions (06-hook.md Section 4)
const ALLOWED_DECISIONS: Record<HookPoint, string[]> = {
  PreRunStart: ["block"],
  PostRunEnd: [],
  PreStepExecute: ["block", "retry"],
  PostStepComplete: [],
  PostStepFailed: [],
  OnStopDecision: ["block"],
  OnFinalizing: [],
  RuntimeStart: [],
};

/** Check if a HookPoint can return a decision (non-empty allowed list). */
function canReturnDecision(point: HookPoint): boolean {
  return (ALLOWED_DECISIONS[point] ?? []).length > 0;
}

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

    let lastResult: HookResult = { decision: "proceed" };
    for (const hook of matching) {
      const startTime = Date.now();
      let result: HookResult;
      try {
        result = await this.runHook(hook, ctx);
      } catch {
        result = { stderr: "Hook execution threw" };
      }

      // Always emit hook_executed audit event with run_id for attribution
      const ev: Record<string, unknown> = {
        type: "hook_executed",
        source: "hook_manager",
        summary: `Hook "${hook.name}" on ${point}: ${result.decision ?? "proceed"}`,
        payload: {
          hook_name: hook.name, point, decision: result.decision,
          stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - startTime,
        },
      };
      if (ctx.run_id) ev.run_id = ctx.run_id as string;
      await this.eb?.emit(ev);

      lastResult = result;

      // Short-circuit only on non-proceed for decision points
      if (canReturnDecision(point) && result.decision && result.decision !== "proceed") {
        return result;
      }
    }

    return lastResult;
  }

  private matches(match: Record<string, string> | undefined, ctx: Record<string, unknown>): boolean {
    if (!match) return true;
    for (const [k, v] of Object.entries(match)) {
      if (ctx[k] !== v) return false;
    }
    return true;
  }

  private async runHook(hook: HookConfig, ctx: Record<string, unknown>): Promise<HookResult> {
    // Parse command: extract script path, interpolate {{variables}} into args
    const tokens = hook.command.split(/\s+/);
    const scriptPath = tokens[0] ?? hook.command;
    await this.validateCommand(scriptPath);

    // Interpolate {{variables}} from ctx, build args array
    const args: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      args.push(token.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(ctx[key] ?? `{{${key}}}`)));
    }
    // Also pass full ctx as JSON for scripts that need structured input
    args.push(JSON.stringify(ctx));

    try {
      const { stdout, stderr } = await execFileP(scriptPath, args, {
        timeout: hook.timeout * 1000,
        maxBuffer: 1024 * 1024,
      });

      const output = stdout.trim();
      if (canReturnDecision(hook.on) && output) {
        try {
          const parsed = JSON.parse(output) as HookResult;
          // Validate decision against ALLOWED_DECISIONS for this hook point
          if (parsed.decision && !(ALLOWED_DECISIONS[hook.on] ?? []).includes(parsed.decision)) {
            return { stdout, stderr, decision: "proceed" };
          }
          return { stdout, stderr, ...parsed };
        } catch {
          return { stdout, stderr };
        }
      }

      return { stdout, stderr };
    } catch (e) {
      const err = e as { code?: string; stderr?: string };
      const msg = err.code === "ENOENT"
        ? `Hook script not found: ${hook.command}`
        : (err.stderr ?? `Hook failed: ${(e as Error).message}`);
      return { stderr: msg };
    }
  }

  /**
   * Validate hook script path: must start with ./ or /, must exist and be readable.
   * Template variables ({{var}}) in the command are handled by runHook, not rejected here.
   */
  private async validateCommand(scriptPath: string): Promise<void> {
    if (!/^\.?\/|^\//.test(scriptPath)) {
      throw new Error(`Hook script must be a file path, got: ${scriptPath}`);
    }
    // Reject shell metacharacters in the script path itself
    if (/[;&|`$(){}\\]/.test(scriptPath)) {
      throw new Error(`Hook script path contains shell metacharacters: ${scriptPath}`);
    }
    await fs.access(scriptPath, fs.constants.R_OK);
  }
}
