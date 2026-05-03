/**
 * Planner exploration tools — lightweight device/capability/history queries.
 *
 * These tools are FREE (no LLM calls, no external API):
 * they read local state and return structured data for the Planner
 * to use during exploration before submitting a plan via submitPlan tool.
 *
 * Uses AI SDK v6 API: tool() with inputSchema + jsonSchema().
 */
import { tool, jsonSchema } from "ai";

interface TargetStateReader {
  getState?(targetId: string): Promise<{ serial: string; adb: string; fastboot: string; state: string; current_run_id?: string } | null>;
  get?(targetId: string): Promise<{ target_id: string; connections: Record<string, unknown>; display_name?: string } | null>;
}

interface MemoryReader {
  listByTarget(targetId: string, limit?: number): Promise<{ episode_id: string; summary: string; result: string; pitfalls: string[]; suggestions: string[] }[]>;
  queryFacts(scope: string, scopeId: string, category?: string): Promise<{ fact_id: string; category: string; statement: string; verified: boolean }[]>;
}

interface SkillReader {
  match(task: string): { name: string; description: string; category: string; steps?: { action: string; capability: string; command?: string; timeout_sec: number }[] }[];
}

export interface PlannerToolDeps {
  targets: { getState?: TargetStateReader["getState"]; get?: TargetStateReader["get"] };
  memory: MemoryReader;
  skills?: SkillReader;
}

const CAPABILITY_DOCS: Record<string, string> = {
  serial: "serial_output → stream (read live serial console output). Typical for monitoring device boot and runtime logs.",
  adb: "shell_exec → exec (run shell commands on device), wait_adb → wait (poll until device is online), adb_logs → stream (live logcat) or exec (logcat -d dump), collect_logs → exec (dmesg, logcat, procfs), push → push (transfer files to device)",
  ssh: "ssh_exec → exec (run commands on device via SSH), push → push (transfer files via SCP/SFTP)",
  fastboot: "flash → flash (write image to partition, command format: 'image_path:partition_name'), reboot → exec (reboot to bootloader/system)",
  local: "local_exec → exec (run commands on the host machine, requires whitelist)",
};

export function createPlannerTools(deps: PlannerToolDeps) {
  return {
    inspectDevice: tool({
      description: "Get comprehensive current state of a target device: connection status, runtime state, available transports, and any active runs. Use this FIRST before planning to understand what the device can do right now.",
      inputSchema: jsonSchema<{ target: string }>({
        type: "object",
        properties: { target: { type: "string", description: "Target device ID" } },
        required: ["target"],
      }),
      execute: async ({ target }) => {
        const [state, profile] = await Promise.all([
          deps.targets.getState?.(target),
          deps.targets.get?.(target),
        ]);
        if (!state && !profile) return `Target "${target}" not found — check target ID`;
        return JSON.stringify({
          state: state?.state ?? "unknown",
          serial: state?.serial ?? "unknown",
          adb: state?.adb ?? "unknown",
          fastboot: state?.fastboot ?? "unknown",
          connections: profile?.connections ? Object.keys(profile.connections) : [],
          active_run: state?.current_run_id ?? null,
        });
      },
    }),

    queryCapability: tool({
      description: "Get documentation for what a transport/capability can do — valid actions, typical use cases, and command formats. Query this for each transport you plan to use instead of guessing from memorized knowledge.",
      inputSchema: jsonSchema<{ transport: string }>({
        type: "object",
        properties: { transport: { type: "string", description: "Transport name: serial, adb, ssh, fastboot, or local" } },
        required: ["transport"],
      }),
      execute: async ({ transport }) => {
        const doc = CAPABILITY_DOCS[transport];
        if (doc) return `${transport}: ${doc}`;
        return `Unknown transport "${transport}". Available: ${Object.keys(CAPABILITY_DOCS).join(", ")}`;
      },
    }),

    getLastEpisodes: tool({
      description: "Get recent validation results for a target including successes, failures, pitfalls to avoid, and suggestions from past runs. Use this to learn from history before planning.",
      inputSchema: jsonSchema<{ target: string; limit?: number }>({
        type: "object",
        properties: {
          target: { type: "string", description: "Target device ID" },
          limit: { type: "number", description: "Max episodes to return (default 5)" },
        },
        required: ["target"],
      }),
      execute: async ({ target, limit = 5 }) => {
        const episodes = await deps.memory.listByTarget(target, limit);
        if (episodes.length === 0) return `No history for target "${target}" — this may be the first run`;
        return JSON.stringify(episodes.map(e => ({
          result: e.result,
          summary: e.summary,
          pitfalls: e.pitfalls,
          suggestions: e.suggestions?.slice(0, 3) ?? [],
        })));
      },
    }),

    getKnownFacts: tool({
      description: "Get known facts and verified patterns about a target device — quirks, known issues, behavioral patterns. These help avoid repeating known mistakes.",
      inputSchema: jsonSchema<{ target: string }>({
        type: "object",
        properties: { target: { type: "string", description: "Target device ID" } },
        required: ["target"],
      }),
      execute: async ({ target }) => {
        const facts = await deps.memory.queryFacts("target", target);
        if (facts.length === 0) return `No known facts for target "${target}"`;
        return JSON.stringify(facts.map(f => ({
          category: f.category,
          statement: f.statement,
          verified: f.verified,
        })));
      },
    }),

    searchSkills: tool({
      description: "Search the skill library for validated plan patterns matching a task description. Returns randomly sampled results — each call may show different examples. Use this to find reference patterns for common validation tasks like firmware flashing, boot verification, or connectivity testing.",
      inputSchema: jsonSchema<{ query: string; limit?: number }>({
        type: "object",
        properties: {
          query: { type: "string", description: "Task description to search for (e.g., 'firmware flash and boot', 'wifi connectivity test')" },
          limit: { type: "number", description: "Max skills to return (default 3)" },
        },
        required: ["query"],
      }),
      execute: async ({ query, limit = 3 }) => {
        if (!deps.skills) return "Skill library not available";
        const skills = deps.skills.match(query);
        if (skills.length === 0) return `No skills found matching "${query}"`;
        const n = Math.min(limit, skills.length);
        const sampled = reservoirSample(skills, n);
        return JSON.stringify(sampled.map(s => ({
          name: s.name,
          description: s.description,
          category: s.category,
          stepCount: s.steps?.length ?? 0,
        })));
      },
    }),
  };
}

function reservoirSample<T>(items: T[], k: number): T[] {
  if (items.length <= k) return [...items];
  const result = items.slice(0, k);
  for (let i = k; i < items.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) result[j] = items[i]!;
  }
  return result;
}
