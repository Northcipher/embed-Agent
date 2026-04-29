import fs from "node:fs/promises";
import path from "node:path";
import { getRunDir } from "./layout.js";
import type { RunRecord, RunState } from "@embed-agent/contracts";

export class RunStore {
  constructor(private dataRoot: string) {}

  private runFile(runId: string): string {
    return path.join(getRunDir(this.dataRoot, runId), "run.json");
  }

  async create(run: RunRecord): Promise<void> {
    const dir = path.dirname(this.runFile(run.run_id));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.runFile(run.run_id), JSON.stringify(run, null, 2), "utf-8");
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const current = await this.get(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const updated = { ...current, ...patch };
    await fs.writeFile(this.runFile(runId), JSON.stringify(updated, null, 2), "utf-8");
  }

  async updateLastEventSeq(runId: string, seq: number): Promise<void> {
    await this.update(runId, { last_event_seq: seq } as Partial<RunRecord>);
  }

  async get(runId: string): Promise<RunRecord | null> {
    try {
      const content = await fs.readFile(this.runFile(runId), "utf-8");
      return JSON.parse(content) as RunRecord;
    } catch {
      return null;
    }
  }

  async listNonTerminal(): Promise<RunRecord[]> {
    const runsDir = path.join(this.dataRoot, "runs");
    const runs: RunRecord[] = [];
    try {
      const entries = await fs.readdir(runsDir);
      for (const entry of entries) {
        const run = await this.get(entry);
        if (run && !["completed", "failed", "cancelled"].includes(run.state)) {
          runs.push(run);
        }
      }
    } catch {
      // runs dir doesn't exist
    }
    return runs;
  }
}
