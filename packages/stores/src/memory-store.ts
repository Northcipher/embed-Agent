import fs from "node:fs/promises";
import path from "node:path";
import { getMemoryDir } from "./layout.js";
import type { WorkingMemoryEntry, Episode, SemanticFact, RunProfile } from "@embed-agent/contracts";

export class MemoryStore {
  constructor(private dataRoot: string) {}

  // Working Memory
  async writeWorkingMemory(runId: string, entries: WorkingMemoryEntry[]): Promise<void> {
    const dir = path.join(getMemoryDir(this.dataRoot), "working-memory");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${runId}.json`), JSON.stringify(entries, null, 2), "utf-8");
  }

  async readWorkingMemory(runId: string): Promise<WorkingMemoryEntry[]> {
    try {
      const content = await fs.readFile(path.join(getMemoryDir(this.dataRoot), "working-memory", `${runId}.json`), "utf-8");
      return JSON.parse(content) as WorkingMemoryEntry[];
    } catch {
      return [];
    }
  }

  // Episode
  async writeEpisode(episode: Episode): Promise<void> {
    const file = path.join(getMemoryDir(this.dataRoot), "episodes.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(episode) + "\n", "utf-8");
  }

  async listByTarget(targetId: string, limit = 10): Promise<Episode[]> {
    const file = path.join(getMemoryDir(this.dataRoot), "episodes.jsonl");
    try {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.trim().split("\n");
      return lines
        .map(l => JSON.parse(l) as Episode)
        .filter(e => e.target_id === targetId)
        .slice(-limit)
        .reverse();
    } catch {
      return [];
    }
  }

  // Semantic Fact
  async writeFact(fact: SemanticFact): Promise<void> {
    const file = path.join(getMemoryDir(this.dataRoot), "semantic-facts.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(fact) + "\n", "utf-8");
  }

  async updateFact(factId: string, patch: Partial<SemanticFact>): Promise<void> {
    const file = path.join(getMemoryDir(this.dataRoot), "semantic-facts.jsonl");
    try {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.trim().split("\n");
      const updated = lines.map(line => {
        const fact = JSON.parse(line) as SemanticFact;
        return fact.fact_id === factId ? JSON.stringify({ ...fact, ...patch }) : line;
      });
      await fs.writeFile(file, updated.join("\n") + "\n", "utf-8");
    } catch {
      // no facts yet
    }
  }

  async queryFacts(
    scope: string, scopeId: string, category?: string, verifiedOnly = false
  ): Promise<SemanticFact[]> {
    const file = path.join(getMemoryDir(this.dataRoot), "semantic-facts.jsonl");
    try {
      const content = await fs.readFile(file, "utf-8");
      return content.trim().split("\n")
        .map(l => JSON.parse(l) as SemanticFact)
        .filter(f => f.scope === scope && f.scope_id === scopeId)
        .filter(f => !category || f.category === category)
        .filter(f => !verifiedOnly || f.verified);
    } catch {
      return [];
    }
  }

  async deleteFact(factId: string): Promise<void> {
    await this.updateFact(factId, { verified: false } as Partial<SemanticFact>);
  }

  // RunProfile
  async writeProfile(profile: RunProfile): Promise<void> {
    const dir = path.join(getMemoryDir(this.dataRoot), "run-profiles");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${profile.run_id}.json`), JSON.stringify(profile, null, 2), "utf-8");
  }

  async getLatestProfile(targetId: string): Promise<RunProfile | null> {
    const dir = path.join(getMemoryDir(this.dataRoot), "run-profiles");
    try {
      const files = await fs.readdir(dir);
      for (const file of files.reverse()) {
        const content = await fs.readFile(path.join(dir, file), "utf-8");
        const profile = JSON.parse(content) as RunProfile;
        if (profile.target_id === targetId) return profile;
      }
    } catch {
      // no profiles yet
    }
    return null;
  }
}
