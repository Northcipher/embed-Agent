/**
 * Planner query tools — lightweight device inspection for pre-plan context.
 */
import { tool } from "ai";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = tool as any;

interface TargetStateReader {
  getState?(targetId: string): Promise<{ serial: string; adb: string; fastboot: string; state: string; current_run_id?: string } | null>;
}

interface MemoryReader {
  listByTarget(targetId: string, limit?: number): Promise<{ episode_id: string; summary: string; result: string; pitfalls: string[] }[]>;
  queryFacts(scope: string, scopeId: string, category?: string): Promise<{ fact_id: string; category: string; statement: string; verified: boolean }[]>;
}

export interface PlannerToolDeps {
  targets: { getState?: TargetStateReader["getState"] };
  memory: MemoryReader;
}

export function createPlannerTools(deps: PlannerToolDeps) {
  return {
    checkDeviceState: T({
      description: "Check if a target device is online and what connections are available",
      parameters: {
        type: "object" as const,
        properties: { target: { type: "string" as const, description: "Target device ID" } },
        required: ["target"],
      },
      execute: async (params: { target: string }) => {
        const state = await deps.targets.getState?.(params.target);
        if (!state) return `Target "${params.target}" not found`;
        return JSON.stringify({ state: state.state, serial: state.serial, adb: state.adb, fastboot: state.fastboot });
      },
    }),

    getLastEpisodes: T({
      description: "Get recent validation results for a target, including failures and pitfalls to avoid",
      parameters: {
        type: "object" as const,
        properties: {
          target: { type: "string" as const, description: "Target device ID" },
          limit: { type: "number" as const, description: "Max episodes (default 3)" },
        },
        required: ["target"],
      },
      execute: async (params: { target: string; limit?: number }) => {
        const episodes = await deps.memory.listByTarget(params.target, params.limit ?? 3);
        return JSON.stringify(episodes.map(e => ({ result: e.result, summary: e.summary, pitfalls: e.pitfalls })));
      },
    }),

    getKnownFacts: T({
      description: "Get known facts and verified patterns about a target device",
      parameters: {
        type: "object" as const,
        properties: { target: { type: "string" as const, description: "Target device ID" } },
        required: ["target"],
      },
      execute: async (params: { target: string }) => {
        const facts = await deps.memory.queryFacts("target", params.target);
        return JSON.stringify(facts.map(f => ({ category: f.category, statement: f.statement, verified: f.verified })));
      },
    }),
  };
}
