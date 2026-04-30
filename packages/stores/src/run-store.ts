import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";
import type { Logger } from "./logger.js";

function validateId(id: string, label: string): void {
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid ${label}: "${id}" contains path characters`);
  }
}

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
  private dataRoot: string;
  /** Per-run mutex for read-modify-write serialization. */
  private locks = new Map<string, Promise<void>>();
  private log: Logger | undefined;

  constructor(dataRoot = ".embed-agent", log?: Logger) {
    this.dataRoot = dataRoot;
    this.log = log;
  }

  private runFile(runId: string): string {
    validateId(runId, "runId");
    return path.join(this.dataRoot, "runs", runId, "run.json");
  }

  /** Serialize mutations per run to prevent lost updates under concurrency. */
  private serialized(runId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(runId, next);
    return next;
  }

  async create(run: RunRecord): Promise<void> {
    await writeAtomic(this.runFile(run.run_id), JSON.stringify(run, null, 2));
  }

  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    await this.serialized(runId, async () => {
      const current = await this.get(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      await writeAtomic(this.runFile(runId), JSON.stringify({ ...current, ...patch }, null, 2));
    });
  }

  async updateLastEventSeq(runId: string, seq: number): Promise<void> {
    await this.serialized(runId, async () => {
      const current = await this.get(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      await writeAtomic(this.runFile(runId), JSON.stringify({ ...current, last_event_seq: seq }, null, 2));
    });
  }

  async get(runId: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.runFile(runId), "utf-8")) as RunRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Corrupted run record ${runId}: ${(e as Error).message}`);
    }
  }

  async listNonTerminal(): Promise<RunRecord[]> {
    const dir = path.join(this.dataRoot, "runs");
    const result: RunRecord[] = [];
    const corrupted: string[] = [];
    try {
      for (const entry of await fs.readdir(dir)) {
        try {
          const r = await this.get(entry);
          if (r && !["completed", "failed", "cancelled"].includes(r.state)) result.push(r);
        } catch (e) {
          // Corrupted run record — surface it, don't silently drop
          corrupted.push(entry);
          const errMsg = (e as Error).message;
          if (this.log) this.log.error(`Corrupted run record "${entry}"`, { error: errMsg });
          else console.error(`[RunStore] Corrupted run record "${entry}": ${errMsg}`);
        }
      }
    } catch { /* dir not exist */ }
    if (corrupted.length > 0) {
      const msg = `${corrupted.length} corrupted run(s) need manual recovery: ${corrupted.join(", ")}`;
      if (this.log) this.log.warn(msg);
      else console.error(`[RunStore] ${msg}`);
    }
    return result;
  }
}
