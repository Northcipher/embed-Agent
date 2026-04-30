import fs from "node:fs/promises";
import path from "node:path";
import { validateId } from "./validate.js";

export interface Skill {
  name: string;
  description: string;
  category: string;
  params: { name: string; type: string; required: boolean; default?: unknown }[];
  steps: { action: string; capability: string; command?: string; timeout_sec: number }[];
  evidence: { always: string[]; on_failure: string[] };
  success: string[];
  failure: string[];
}

export class SkillStore {
  private skills: Map<string, Skill> = new Map();

  constructor(private dataRoot = ".embed-agent") {}

  async loadAll(): Promise<void> {
    this.skills.clear();
    // Load from skills/ (system) and skills/custom/ directories
    for (const dir of ["skills", "skills/custom"]) {
      const skillDir = path.join(this.dataRoot, dir);
      try {
        for (const entry of await fs.readdir(skillDir)) {
          if (!entry.endsWith(".json")) continue;
          try {
            const content = await fs.readFile(path.join(skillDir, entry), "utf-8");
            const skill = JSON.parse(content) as Skill;
            if (skill.name && skill.steps) {
              this.skills.set(skill.name, skill);
            }
          } catch { /* skip malformed skill files */ }
        }
      } catch { /* dir not exist */ }
    }
  }

  /** Match skills by category + task keyword. Returns ranked results. */
  match(task: string): Skill[] {
    const keywords = task.toLowerCase().split(/\s+/);
    const results: Skill[] = [];
    for (const skill of this.skills.values()) {
      const text = `${skill.category} ${skill.name} ${skill.description}`.toLowerCase();
      const score = keywords.filter(k => text.includes(k)).length;
      if (score > 0) results.push({ ...skill, _score: score } as never);
    }
    results.sort((a, b) => ((b as never as { _score: number })._score - (a as never as { _score: number })._score));
    return results;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async create(name: string, skill: Skill): Promise<void> {
    validateId(name, "skillName");
    this.skills.set(name, skill);
    const dir = path.join(this.dataRoot, "skills", "custom");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(skill, null, 2), "utf-8");
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
}
