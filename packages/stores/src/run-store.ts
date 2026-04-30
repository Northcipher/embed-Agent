import fs from "node:fs/promises";
import path from "node:path";

export type RunState = "planning" | "running" | "paused" | "collecting_evidence" | "finalizing" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  run_id: string;
  session_id: string;
  state: RunState;
  target_id: string;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  plan_ref?: string;
  current_step_id?: string;
  elapsed_sec: number;
  last_event_seq: number;
  evidence_root: string;
  failure_reason?: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
}

export class RunStore {
  constructor(private dataRoot = ".embed-agent") {}

  private runFile(runId: string): string {
    return path.join(this.dataRoot, "runs", runId, "run.json");
  }

  async create(run: RunRecord): Promise<void> {
    const file = this.runFile(run.run_id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(run, null, 2), "utf-8");
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const current = await this.get(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    await fs.writeFile(this.runFile(runId), JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
  }

  async updateLastEventSeq(runId: string, seq: number): Promise<void> {
    await this.update(runId, { last_event_seq: seq } as Partial<RunRecord>);
  }

  async get(runId: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as RunRecord;
    } catch { return null; }
  }

  async listNonTerminal(): Promise<RunRecord[]> {
    const dir = path.join(this.dataRoot, "runs");
    const result: RunRecord[] = [];
    try {
      for (const entry of await fs.readdir(dir)) {
        const r = await this.get(entry);
        if (r && !["completed", "failed", "cancelled"].includes(r.state)) result.push(r);
      }
    } catch { /* dir not exist */ }
    return result;
  }
}
