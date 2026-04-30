interface MemoryStoreLike {
  writeWorkingMemory(runId: string, entries: { key: string; summary: string; source: string; at: string }[]): Promise<void>;
  readWorkingMemory(runId: string): Promise<{ key: string; summary: string; source: string; at: string }[]>;
  writeEpisode(ep: { episode_id: string; run_id: string; target_id: string; artifact_ref: string; task: string; result: string; summary: string; key_evidence: { summary: string; refs: string[] }[]; suggestions: string[]; pitfalls: string[]; recorded_at: string }): Promise<void>;
  listByTarget(targetId: string, limit?: number): Promise<{ episode_id: string; run_id: string; target_id: string; result: string; summary: string; key_evidence: { summary: string; refs: string[] }[]; suggestions: string[]; pitfalls: string[]; recorded_at: string }[]>;
  writeFact(fact: { fact_id: string; scope: string; scope_id: string; category: string; statement: string; source: string; evidence_refs: string[]; extended_pattern?: string; verified: boolean; created_at: string }): Promise<void>;
  updateFact(factId: string, patch: Record<string, unknown>): Promise<void>;
  queryFacts(scope: string, scopeId: string, category?: string, verifiedOnly?: boolean): Promise<{ fact_id: string; scope: string; scope_id: string; category: string; statement: string; source: string; evidence_refs: string[]; extended_pattern?: string; verified: boolean; created_at: string }[]>;
  writeProfile(profile: { run_id: string; target_id: string; artifact: { path: string; type: string; version?: string; build_id?: string }; result: string; stage_durations: { stage: string; duration: number }[]; final_metrics: Record<string, number>; output_summary: { total_lines: number; peak_lines_per_sec: number; silence_count: number; rule_hits: Record<string, number> }; recorded_at: string }): Promise<void>;
  getLatestProfile(targetId: string): Promise<{ run_id: string; result: string; stage_durations: { stage: string; duration: number }[]; final_metrics: Record<string, number>; output_summary: { total_lines: number; peak_lines_per_sec: number; silence_count: number; rule_hits: Record<string, number> } } | null>;
}

export class Memory {
  constructor(private store: MemoryStoreLike) {}

  async writeWorkingMemory(runId: string, entry: { key: string; summary: string; source: "observer" | "planner" | "human" }): Promise<void> {
    await this.store.writeWorkingMemory(runId, [{ ...entry, at: new Date().toISOString() }]);
  }

  async readWorkingMemory(runId: string): Promise<{ key: string; summary: string; source: string }[]> {
    return this.store.readWorkingMemory(runId);
  }

  async recordEpisode(episode: {
    episode_id: string; run_id: string; target_id: string; artifact_ref: string; task: string;
    result: string; summary: string; key_evidence: { summary: string; refs: string[] }[];
    suggestions: string[]; pitfalls: string[];
  }): Promise<void> {
    await this.store.writeEpisode({ ...episode, recorded_at: new Date().toISOString() });
  }

  async recallEpisodes(targetId: string, limit = 5): Promise<{ episode_id: string; summary: string; result: string; key_evidence: { summary: string; refs: string[] }[]; suggestions: string[]; pitfalls: string[] }[]> {
    return this.store.listByTarget(targetId, limit);
  }

  async writeFact(fact: {
    fact_id: string; scope: string; scope_id: string; category: string; statement: string;
    source: "auto" | "human_confirmed"; evidence_refs: string[]; extended_pattern?: string;
  }): Promise<void> {
    await this.store.writeFact({ ...fact, verified: fact.source === "human_confirmed", created_at: new Date().toISOString() });
  }

  async queryFacts(scope: string, scopeId: string, category?: string): Promise<{ fact_id: string; category: string; statement: string; verified: boolean }[]> {
    return this.store.queryFacts(scope, scopeId, category);
  }

  async confirmFact(factId: string): Promise<void> {
    await this.store.updateFact(factId, { verified: true });
  }

  async deleteFact(factId: string): Promise<void> {
    await this.store.updateFact(factId, { verified: false, statement: "__DELETED__" });
  }

  async recordRunProfile(profile: {
    run_id: string; target_id: string; artifact: { path: string; type: string; version?: string; build_id?: string };
    result: "completed" | "failed" | "cancelled";
    stage_durations: { stage: string; duration: number }[];
    final_metrics: Record<string, number>;
    output_summary: { total_lines: number; peak_lines_per_sec: number; silence_count: number; rule_hits: Record<string, number> };
  }): Promise<void> {
    await this.store.writeProfile({ ...profile, recorded_at: new Date().toISOString() });
  }

  async getLatestProfile(targetId: string): Promise<{ run_id: string; result: string; stage_durations: { stage: string; duration: number }[]; final_metrics: Record<string, number>; output_summary: { total_lines: number; peak_lines_per_sec: number; silence_count: number; rule_hits: Record<string, number> } } | null> {
    return this.store.getLatestProfile(targetId);
  }
}
