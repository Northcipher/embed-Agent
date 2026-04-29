import fs from "node:fs/promises";
import path from "node:path";
import { getRunDir } from "./layout.js";
import { RunStore } from "./run-store.js";

export interface CleanupConfig {
  success_days: number;
  failure_days: number;
  max_total_bytes?: number;
}

export class EvidenceCleanup {
  constructor(
    private dataRoot: string,
    private config: CleanupConfig,
    private runStore: RunStore,
  ) {}

  async cleanup(): Promise<number> {
    let freedBytes = 0;
    const runsDir = path.join(this.dataRoot, "runs");

    try {
      const entries = await fs.readdir(runsDir);
      const now = Date.now();

      for (const runId of entries) {
        const run = await this.runStore.get(runId);
        if (!run) continue;

        const runDir = getRunDir(this.dataRoot, runId);
        const retentionDays = run.state === "failed" ? this.config.failure_days : this.config.success_days;
        const endedAt = run.ended_at ? new Date(run.ended_at).getTime() : 0;

        if (endedAt > 0 && (now - endedAt) > retentionDays * 86400_000) {
          try {
            // Don't delete important runs
            if (run.failure_reason === "important") continue;
            const size = await this.dirSize(runDir);
            await fs.rm(runDir, { recursive: true, force: true });
            freedBytes += size;
          } catch {
            // couldn't delete
          }
        }
      }
    } catch {
      // no runs yet
    }

    return freedBytes;
  }

  private async dirSize(dirPath: string): Promise<number> {
    let size = 0;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          size += await this.dirSize(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          size += stat.size;
        }
      }
    } catch {
      // can't read
    }
    return size;
  }
}
