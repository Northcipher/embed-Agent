import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";

export interface WorkingMemoryEntry {
  key: string; summary: string;
  source: "observer" | "planner" | "human"; at: string;
}

export interface Episode {
  episode_id: string; run_id: string; target_id: string;
  artifact_ref: string; task: string;
  result: string; summary: string;
  key_evidence: { summary: string; refs: string[] }[];
  suggestions: string[]; pitfalls: string[]; recorded_at: string;
}

export interface SemanticFact {
  fact_id: string; scope: string; scope_id: string;
  category: string; statement: string;
  source: "auto" | "human_confirmed";
  evidence_refs: string[]; extended_pattern?: string;
  verified: boolean; created_at: string;
}

export interface RunProfile {
  run_id: string; target_id: string;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  result: "completed" | "failed" | "cancelled";
  stage_durations: { stage: string; duration: number }[];
  final_metrics: Record<string, number>;
  output_summary: { total_lines: number; peak_lines_per_sec: number; silence_count: number; rule_hits: Record<string, number> };
  recorded_at: string;
}

export class MemoryStore {
  constructor(private dataRoot = ".embed-agent") {}

  private memDir() { return path.join(this.dataRoot, "memory"); }

  async writeWorkingMemory(runId: string, entries: WorkingMemoryEntry[]): Promise<void> {
    const dir = path.join(this.memDir(), "working-memory");
    await writeAtomic(path.join(dir, `${runId}.json`), JSON.stringify(entries));
  }

  async readWorkingMemory(runId: string): Promise<WorkingMemoryEntry[]> {
    try { return JSON.parse(await fs.readFile(path.join(this.memDir(), "working-memory", `${runId}.json`), "utf-8")) as WorkingMemoryEntry[]; }
    catch { return []; }
  }

  async writeEpisode(ep: Episode): Promise<void> {
    await fs.mkdir(this.memDir(), { recursive: true });
    await fs.appendFile(path.join(this.memDir(), "episodes.jsonl"), JSON.stringify(ep) + "\n", "utf-8");
  }

  async listByTarget(targetId: string, limit = 10): Promise<Episode[]> {
    try {
      const lines = (await fs.readFile(path.join(this.memDir(), "episodes.jsonl"), "utf-8")).trim().split("\n");
      return lines.map(l => JSON.parse(l) as Episode).filter(e => e.target_id === targetId).slice(-limit).reverse();
    } catch { return []; }
  }

  async writeFact(fact: SemanticFact): Promise<void> {
    await fs.mkdir(this.memDir(), { recursive: true });
    await fs.appendFile(path.join(this.memDir(), "semantic-facts.jsonl"), JSON.stringify(fact) + "\n", "utf-8");
  }

  async updateFact(factId: string, patch: Partial<SemanticFact>): Promise<void> {
    const file = path.join(this.memDir(), "semantic-facts.jsonl");
    try {
      const lines = (await fs.readFile(file, "utf-8")).trim().split("\n");
      const updated = lines.map(l => {
        const f = JSON.parse(l) as SemanticFact;
        return f.fact_id === factId ? JSON.stringify({ ...f, ...patch }) : l;
      });
      await writeAtomic(file, updated.join("\n") + "\n");
    } catch { /* no facts yet */ }
  }

  async queryFacts(scope: string, scopeId: string, category?: string, verifiedOnly = false): Promise<SemanticFact[]> {
    try {
      const lines = (await fs.readFile(path.join(this.memDir(), "semantic-facts.jsonl"), "utf-8")).trim().split("\n");
      return lines.map(l => JSON.parse(l) as SemanticFact)
        .filter(f => f.scope === scope && f.scope_id === scopeId)
        .filter(f => !category || f.category === category)
        .filter(f => !verifiedOnly || f.verified)
        .filter(f => f.statement !== "__DELETED__");
    } catch { return []; }
  }

  async deleteFact(factId: string): Promise<void> {
    await this.updateFact(factId, { verified: false, statement: "__DELETED__" } as Partial<SemanticFact>);
  }

  async writeProfile(profile: RunProfile): Promise<void> {
    const dir = path.join(this.memDir(), "run-profiles");
    await writeAtomic(path.join(dir, `${profile.run_id}.json`), JSON.stringify(profile));
  }

  async getLatestProfile(targetId: string): Promise<RunProfile | null> {
    const dir = path.join(this.memDir(), "run-profiles");
    try {
      const profiles: RunProfile[] = [];
      for (const f of await fs.readdir(dir)) {
        const p = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8")) as RunProfile;
        if (p.target_id === targetId) profiles.push(p);
      }
      profiles.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
      return profiles[0] ?? null;
    } catch { return null; }
  }
}
