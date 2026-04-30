import fs from "node:fs/promises";
import path from "node:path";
import { validateId } from "./validate.js";

export type PromptRole = "planner" | "observer" | "reply";

export interface PromptSet {
  role: PromptRole;
  version: string;
  system: string;
}

export class PromptLoader {
  private cache = new Map<string, PromptSet>();

  constructor(private promptsRoot: string) {}

  /** Load a prompt from prompts/{role}-v{version}.md */
  async load(role: PromptRole, version: string): Promise<PromptSet> {
    validateId(version, "version");
    const cacheKey = `${role}-${version}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    const fileName = `${role}-v${version}.md`;
    const filePath = path.join(this.promptsRoot, fileName);

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      // Try without version
      const fallbackPath = path.join(this.promptsRoot, `${role}.md`);
      try {
        content = await fs.readFile(fallbackPath, "utf-8");
      } catch {
        throw new Error(`Prompt not found: ${role} (tried ${fileName} and ${role}.md)`);
      }
    }

    // Split frontmatter from body
    const system = this.extractSystem(content);

    const prompt: PromptSet = { role, version, system };
    this.cache.set(cacheKey, prompt);
    return prompt;
  }

  private extractSystem(content: string): string {
    // If content has YAML frontmatter (--- delimited), extract the body
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    if (match) return match[1]!.trim();
    return content.trim();
  }

  /** Load all prompts for a version. */
  async loadAll(version: string): Promise<Map<PromptRole, PromptSet>> {
    const roles: PromptRole[] = ["planner", "observer", "reply"];
    const result = new Map<PromptRole, PromptSet>();
    for (const role of roles) {
      try {
        const prompt = await this.load(role, version);
        result.set(role, prompt);
      } catch { /* skip missing */ }
    }
    return result;
  }

  /** Preload and cache prompts for a version. */
  async preload(version: string): Promise<void> {
    await this.loadAll(version);
  }
}
