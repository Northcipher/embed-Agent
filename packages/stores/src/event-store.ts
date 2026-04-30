import fs from "node:fs/promises";
import path from "node:path";

export interface EventRecord {
  seq: number;
  run_id?: string;
  time: string;
  type: string;
  source: string;
  summary: string;
  payload: Record<string, unknown>;
  severity?: string;
  step_id?: string;
  elapsed_sec?: number;
  evidence_refs?: string[];
}

async function readLastSeq(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) return 0;
    return (JSON.parse(lines[lines.length - 1]!) as EventRecord).seq;
  } catch {
    return 0;
  }
}

export class EventStore {
  constructor(private dataRoot = ".embed-agent") {}

  private runEventsPath(runId: string): string {
    return path.join(this.dataRoot, "runs", runId, "events.jsonl");
  }

  private globalEventsPath(): string {
    return path.join(this.dataRoot, "events.jsonl");
  }

  async append(runId: string, event: EventRecord): Promise<{ seq: number }> {
    const file = this.runEventsPath(runId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const seq = (await readLastSeq(file)) + 1;
    await fs.appendFile(file, JSON.stringify({ ...event, seq, time: new Date().toISOString() }) + "\n", "utf-8");
    return { seq };
  }

  async appendGlobal(event: EventRecord): Promise<{ seq: number }> {
    const file = this.globalEventsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const seq = (await readLastSeq(file)) + 1;
    await fs.appendFile(file, JSON.stringify({ ...event, seq, time: new Date().toISOString() }) + "\n", "utf-8");
    return { seq };
  }

  async read(runId: string, afterSeq = 0, limit = 100): Promise<EventRecord[]> {
    try {
      const content = await fs.readFile(this.runEventsPath(runId), "utf-8");
      return content.trim().split("\n")
        .map(l => JSON.parse(l) as EventRecord)
        .filter(e => e.seq > afterSeq)
        .slice(0, limit);
    } catch { return []; }
  }

  async readGlobal(afterSeq = 0, limit = 100): Promise<EventRecord[]> {
    try {
      const content = await fs.readFile(this.globalEventsPath(), "utf-8");
      return content.trim().split("\n")
        .map(l => JSON.parse(l) as EventRecord)
        .filter(e => e.seq > afterSeq)
        .slice(0, limit);
    } catch { return []; }
  }
}
