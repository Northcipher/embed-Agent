import type { HookConfig, HookResult, HookPoint, HookContext } from "@embed-agent/contracts";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(cpExec);

const ALLOWED_DECISIONS: Record<string, string[]> = {
  PreRunStart: ["proceed"],
  PostRunEnd: ["proceed"],
  PreStepExecute: ["proceed", "block", "retry"],
  PostStepComplete: ["proceed"],
  PostStepFailed: ["proceed"],
  OnStopDecision: ["proceed", "block"],
  OnFinalizing: ["proceed"],
  RuntimeStart: ["proceed"],
};

export class HookManager {
  private hooks: HookConfig["hooks"] = [];

  load(config: HookConfig): void {
    this.hooks = config.hooks;
  }

  async execute(point: HookPoint, context: HookContext): Promise<HookResult> {
    const matched = this.hooks.filter(h => h.on === point);
    for (const hook of matched) {
      if (hook.match && !this.matchesFilter(hook.match, context)) continue;

      const cmd = this.interpolate(hook.command, context);
      try {
        const { stdout } = await execAsync(cmd, { timeout: hook.timeout * 1000 });
        const parsed = JSON.parse(stdout.trim() || "{}") as HookResult;
        const allowedDecisions = ALLOWED_DECISIONS[point] ?? ["proceed"];
        if (!allowedDecisions.includes(parsed.decision)) return { decision: "proceed" };
        if (parsed.decision !== "proceed") return parsed;
      } catch {
        // Hook failure → proceed. Don't block.
        return { decision: "proceed" };
      }
    }
    return { decision: "proceed" };
  }

  private matchesFilter(match: Record<string, string>, ctx: HookContext): boolean {
    return Object.entries(match).every(([k, v]) => (ctx as Record<string, unknown>)[k] === v);
  }

  private interpolate(cmd: string, ctx: HookContext): string {
    return cmd.replace(/\{\{(\w+)\}\}/g, (_, key) => String((ctx as Record<string, unknown>)[key] ?? ""));
  }
}
