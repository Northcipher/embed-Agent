import fs from "node:fs/promises";
import path from "node:path";
import type { EventType } from "@embed-agent/contracts";

// --- Types ---

/** Fields the caller provides when appending an event. seq and time are assigned by the store. */
export interface AppendEvent {
  type: EventType | string;
  source: string;
  summary: string;
  payload: Record<string, unknown>;
  run_id?: string;
  severity?: string;
  step_id?: string;
  elapsed_sec?: number;
  evidence_refs?: string[];
}

/** Persisted event record with store-assigned seq and time. */
export interface EventRecord extends AppendEvent {
  seq: number;
  time: string;
}

// --- Validation ---

function validateId(id: string, label: string): void {
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid ${label}: "${id}" contains path characters`);
  }
}

// --- Seq reading ---

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

// --- Event Store ---

export class EventStore {
  private dataRoot: string;
  /** Per-file mutex: chains promises to serialize read-modify-append per event stream. */
  private locks = new Map<string, Promise<void>>();

  constructor(dataRoot = ".embed-agent") {
    this.dataRoot = path.resolve(dataRoot);
  }

  private runEventsPath(runId: string): string {
    validateId(runId, "runId");
    return path.join(this.dataRoot, "runs", runId, "events.jsonl");
  }

  private globalEventsPath(): string {
    return path.join(this.dataRoot, "events.jsonl");
  }

  /** Serialize append ops per file to prevent duplicate seq under concurrent calls. */
  private serialized(file: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(file) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn even if prev rejected
    this.locks.set(file, next);
    return next;
  }

  async append(runId: string, event: AppendEvent): Promise<{ seq: number }> {
    const file = this.runEventsPath(runId);
    let seq = 0;

    await this.serialized(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      seq = (await readLastSeq(file)) + 1;
      await fs.appendFile(file, JSON.stringify({ ...event, seq, time: new Date().toISOString() }) + "\n", "utf-8");
    });

    return { seq };
  }

  async appendGlobal(event: AppendEvent): Promise<{ seq: number }> {
    const file = this.globalEventsPath();
    let seq = 0;

    await this.serialized(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      seq = (await readLastSeq(file)) + 1;
      await fs.appendFile(file, JSON.stringify({ ...event, seq, time: new Date().toISOString() }) + "\n", "utf-8");
    });

    return { seq };
  }

  async read(runId: string, afterSeq = 0, limit = 100): Promise<EventRecord[]> {
    validateId(runId, "runId");
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

  /**
   * Subscribe this EventStore to an EventBus for automatic persistence.
   * Events with run_id → runs/{run_id}/events.jsonl + RunStore lastEventSeq update.
   * Events without run_id → global events.jsonl.
   */
  subscribeToBus(
    bus: { subscribe(types: string[], handler: (e: Record<string, unknown>) => void): () => void },
    runStore?: { updateLastEventSeq(runId: string, seq: number): Promise<void> },
  ): () => void {
    return bus.subscribe(["*"], async (event) => {
      try {
        const entry = event as unknown as AppendEvent;
        if (event.run_id) {
          const { seq } = await this.append(event.run_id as string, entry);
          if (runStore) {
            await runStore.updateLastEventSeq(event.run_id as string, seq).catch(() => {});
          }
        } else {
          await this.appendGlobal(entry);
        }
      } catch { /* persistence failure shouldn't crash */ }
    });
  }
}
