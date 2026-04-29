import fs from "node:fs/promises";
import path from "node:path";

export type PromptRole = "planner" | "observer" | "reply";

export interface PromptRecord {
  role: PromptRole;
  version: number;
  system: string;
}

export class PromptLoader {
  constructor(private promptsDir: string) {}

  async load(role: PromptRole): Promise<PromptRecord> {
    // Find latest version
    const files = await this.listVersions(role);
    if (files.length === 0) {
      throw new Error(`No prompt found for role: ${role}`);
    }
    const latest = files[files.length - 1];
    const content = await fs.readFile(path.join(this.promptsDir, latest), "utf-8");
    const version = parseInt(latest.match(/v(\d+)/)?.[1] ?? "0", 10);
    return { role, version, system: content };
  }

  async loadVersion(role: PromptRole, version: number): Promise<PromptRecord> {
    const fileName = `${role}.v${version}.md`;
    const content = await fs.readFile(path.join(this.promptsDir, fileName), "utf-8");
    return { role, version, system: content };
  }

  private async listVersions(role: PromptRole): Promise<string[]> {
    try {
      const files = await fs.readdir(this.promptsDir);
      return files
        .filter(f => f.startsWith(`${role}.v`) && f.endsWith(".md"))
        .sort((a, b) => {
          const va = parseInt(a.match(/v(\d+)/)?.[1] ?? "0", 10);
          const vb = parseInt(b.match(/v(\d+)/)?.[1] ?? "0", 10);
          return va - vb;
        });
    } catch {
      return [];
    }
  }
}
