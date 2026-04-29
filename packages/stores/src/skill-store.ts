import fs from "node:fs/promises";
import path from "node:path";
import { getSkillsDir } from "./layout.js";
import type { Skill } from "@embed-agent/contracts";

export class SkillStore {
  constructor(private dataRoot: string) {}

  async loadAll(): Promise<Skill[]> {
    const dirs = [
      getSkillsDir(this.dataRoot),
      path.join(getSkillsDir(this.dataRoot), "custom"),
    ];
    const skills: Skill[] = [];
    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const content = await fs.readFile(path.join(dir, file), "utf-8");
          skills.push(JSON.parse(content) as Skill);
        }
      } catch {
        // dir doesn't exist yet
      }
    }
    return skills;
  }

  async load(name: string): Promise<Skill | null> {
    const dirs = [
      getSkillsDir(this.dataRoot),
      path.join(getSkillsDir(this.dataRoot), "custom"),
    ];
    for (const dir of dirs) {
      try {
        const content = await fs.readFile(path.join(dir, `${name}.json`), "utf-8");
        return JSON.parse(content) as Skill;
      } catch {
        continue;
      }
    }
    return null;
  }

  async loadByTarget(targetId: string): Promise<Skill[]> {
    const dir = path.join(this.dataRoot, "targets", targetId, "skills");
    try {
      const files = await fs.readdir(dir);
      const skills: Skill[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await fs.readFile(path.join(dir, file), "utf-8");
        skills.push(JSON.parse(content) as Skill);
      }
      return skills;
    } catch {
      return [];
    }
  }

  async save(name: string, skill: Skill): Promise<void> {
    const dir = path.join(getSkillsDir(this.dataRoot), "custom");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(skill, null, 2), "utf-8");
  }
}
