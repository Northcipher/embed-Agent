import type { RunRecord } from "@embed-agent/stores";
import type { EventRecord } from "@embed-agent/stores";

interface RunStoreReader {
  get(runId: string): Promise<RunRecord | null>;
}

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<EventRecord[]>;
}

interface TargetStoreReader {
  get(targetId: string): Promise<{ target_id: string; display_name?: string; target_hints?: Record<string, unknown>; connections: Record<string, unknown> } | null>;
}

interface MemoryReader {
  listByTarget(targetId: string, limit?: number): Promise<{ episode_id: string; summary: string; result: string; key_evidence: { summary: string; refs: string[] }[]; suggestions: string[]; pitfalls: string[] }[]>;
  queryFacts(scope: string, scopeId: string, category?: string, verifiedOnly?: boolean): Promise<{ fact_id: string; category: string; statement: string; verified: boolean }[]>;
  readWorkingMemory(runId: string): Promise<{ key: string; summary: string; source: string }[]>;
}

export interface PlannerContext {
  staticPrompt: string;
  dynamicContext: {
    target_id: string;
    target_hints: Record<string, unknown>;
    connections: Record<string, unknown>;
    artifact: RunRecord["artifact"];
    relevant_episodes: { episode_id: string; summary: string; result: string }[];
    relevant_facts: { fact_id: string; category: string; statement: string }[];
    pitfalls: string[];
  };
}

export interface ObserverContext {
  staticPrompt: string;
  input: {
    triggering_event: EventRecord;
    recent_events: EventRecord[];
    working_memory: { key: string; summary: string; source: string }[];
    relevant_facts: { fact_id: string; category: string; statement: string }[];
    circuit_breaker_active: boolean;
    warning_escalation: boolean;
  };
}

const PLANNER_PROMPT = `You are an embedded device validation agent. Your task is to create a concrete, executable plan to validate an artifact on a target device.

Given the context below, produce a step-by-step plan. Each step must have:
- id: unique step identifier
- capability: what capability this step needs (shell_exec, serial_output, adb_logs, wait_adb, flash, push, collect_logs)
- action: exec, stream, push, flash, or wait
- command: the exact command to run (if applicable)
- timeout_sec: maximum time for this step

Consider the target hints, past episodes, and known facts. Avoid repeating known pitfalls.`;

const OBSERVER_PROMPT = `You are an embedded device observer. Your role is to decide whether a validation run should continue, stop, or collect more evidence based on the events and signals you see.

Respond with a decision:
- continue: everything looks normal, keep going
- stop: a fatal condition was detected, end the run
- collect_more: suspicious signal, gather additional evidence
- extend_wait: need more time, extend the current step timeout
- pause: non-fatal but needs human attention
- suggest: make a suggestion but don't interrupt`;

export class ContextAssembler {
  private plannerPrompt: string;
  private observerPrompt: string;

  constructor(
    private runStore: RunStoreReader,
    private eventStore: EventStoreReader,
    private targetStore: TargetStoreReader,
    private memory: MemoryReader,
    prompts?: { planner?: string; observer?: string },
  ) {
    this.plannerPrompt = prompts?.planner ?? PLANNER_PROMPT;
    this.observerPrompt = prompts?.observer ?? OBSERVER_PROMPT;
  }

  async assemblePlannerContext(runId: string): Promise<PlannerContext> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const target = await this.targetStore.get(run.target_id);
    const episodes = await this.memory.listByTarget(run.target_id, 5);
    const facts = await this.memory.queryFacts("target", run.target_id);

    return {
      staticPrompt: this.plannerPrompt,
      dynamicContext: {
        target_id: run.target_id,
        target_hints: target?.target_hints ?? {},
        connections: target?.connections ?? {},
        artifact: run.artifact,
        relevant_episodes: episodes.map(e => ({
          episode_id: e.episode_id, summary: e.summary, result: e.result,
        })),
        relevant_facts: facts.map(f => ({
          fact_id: f.fact_id, category: f.category, statement: f.statement,
        })),
        pitfalls: episodes.flatMap(e => e.pitfalls),
      },
    };
  }

  async assembleObserverContext(
    runId: string,
    triggeringEvent: EventRecord,
    circuitBreakerActive = false,
    warningEscalation = false,
  ): Promise<ObserverContext> {
    const run = await this.runStore.get(runId);
    const targetId = run?.target_id ?? "";

    const [recentEvents, wm, facts] = await Promise.all([
      this.eventStore.read(runId, Math.max(0, triggeringEvent.seq - 100), 50),
      this.memory.readWorkingMemory(runId),
      this.memory.queryFacts("target", targetId, undefined, true),
    ]);

    return {
      staticPrompt: this.observerPrompt,
      input: {
        triggering_event: triggeringEvent,
        recent_events: recentEvents,
        working_memory: wm.map(w => ({ key: w.key, summary: w.summary, source: w.source })),
        relevant_facts: facts.map(f => ({
          fact_id: f.fact_id, category: f.category, statement: f.statement,
        })),
        circuit_breaker_active: circuitBreakerActive,
        warning_escalation: warningEscalation,
      },
    };
  }
}
