import type { Plan, Decision } from "@embed-agent/contracts";
import type { LLMCallManager } from "./llm-call-manager.js";

// Minimal stubs for Phase 4

export class Planner {
  constructor(private llm: LLMCallManager) {}
  async call(_staticPrompt: string, _dynamicContext: Record<string, unknown>): Promise<{ status: string; plan?: Plan }> {
    return { status: "planned", plan: { plan_id: "plan-default", estimated_duration_sec: 360, steps: [], evidence_policy: { always: [], on_failure: [] }, success_criteria: [], failure_signals: [] } };
  }
}

export class Observer {
  constructor(private llm: LLMCallManager) {}
  async decide(_staticPrompt: string, _input: Record<string, unknown>): Promise<Decision> {
    return { decision: "continue", reason: "no issues", confidence: 0.9, reasoning_trace: "stub", evidence_refs: [] };
  }
}

export class ReplyGenerator {
  constructor(private llm: LLMCallManager) {}
  async generate(_runId: string): Promise<AgentReply> {
    return { run_id: _runId, status: "completed", summary: "Run completed", key_evidence: [], suggested_next: "", evidence_path: "", confidence: 0.5 };
  }
  async generateMinimal(runId: string, reason: string): Promise<AgentReply> {
    return { run_id: runId, status: "failed", summary: reason, key_evidence: [], suggested_next: "", evidence_path: "", confidence: 0.5 };
  }
  async generateCancelled(runId: string, reason: string): Promise<AgentReply> {
    return { run_id: runId, status: "cancelled", summary: reason, key_evidence: [], suggested_next: "", evidence_path: "", confidence: 0.5 };
  }
}

import type { MemoryStore } from "@embed-agent/stores";

export class Memory {
  constructor(private store: MemoryStore) {}
  async writeWorkingMemory(runId: string, entry: Record<string, unknown>): Promise<void> {
    await this.store.writeWorkingMemory(runId, [entry] as unknown as never[]);
  }
  async readWorkingMemory(runId: string): Promise<unknown[]> {
    return this.store.readWorkingMemory(runId);
  }
  async recallEpisodes(targetId: string, limit = 10): Promise<unknown[]> {
    return this.store.listByTarget(targetId, limit);
  }
  async recordEpisode(episode: Record<string, unknown>): Promise<void> {
    await this.store.writeEpisode(episode as unknown as never);
  }
}

export class SkillRegistry {
  private skills: Record<string, unknown>[] = [];
  async loadAll(skills: Record<string, unknown>[]): Promise<void> { this.skills = skills; }
  async match(_task: string): Promise<Record<string, unknown>[]> { return this.skills.slice(0, 3); }
  async get(name: string): Promise<Record<string, unknown> | null> { return this.skills.find(s => s.name === name) ?? null; }
}
