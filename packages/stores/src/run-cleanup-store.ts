import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";
import { validateId } from "./validate.js";
import type { Episode } from "./memory-store.js";
import type { RunRecord, RunState } from "./run-store.js";

export type DeleteRunResult =
  | { status: "deleted"; run_id: string }
  | { status: "not_found"; run_id: string }
  | { status: "run_active"; run_id: string; state: RunState };

const TERMINAL_STATES: RunState[] = ["completed", "failed", "cancelled"];

export class RunCleanupStore {
  constructor(private dataRoot = ".embed-agent") {}

  async deleteRun(runId: string): Promise<DeleteRunResult> {
    validateId(runId, "runId");
    const run = await this.readRun(runId);
    if (!run) return { status: "not_found", run_id: runId };
    if (!TERMINAL_STATES.includes(run.state)) {
      return { status: "run_active", run_id: runId, state: run.state };
    }

    await Promise.all([
      fs.rm(this.runDir(runId), { recursive: true, force: true }),
      this.deleteWorkingMemory(runId),
      this.deleteRunProfile(runId),
      this.deleteEpisodes(runId),
    ]);

    return { status: "deleted", run_id: runId };
  }

  private runDir(runId: string): string {
    return path.join(this.dataRoot, "runs", runId);
  }

  private memoryDir(): string {
    return path.join(this.dataRoot, "memory");
  }

  private async readRun(runId: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.runDir(runId), "run.json"), "utf-8")) as RunRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Corrupted run record ${runId}: ${(e as Error).message}`);
    }
  }

  private async deleteWorkingMemory(runId: string): Promise<void> {
    await fs.rm(path.join(this.memoryDir(), "working-memory", `${runId}.json`), { force: true });
  }

  private async deleteRunProfile(runId: string): Promise<void> {
    await fs.rm(path.join(this.memoryDir(), "run-profiles", `${runId}.json`), { force: true });
  }

  private async deleteEpisodes(runId: string): Promise<void> {
    const file = path.join(this.memoryDir(), "episodes.jsonl");
    try {
      const raw = await fs.readFile(file, "utf-8");
      const lines = raw.split("\n").filter(line => line.trim().length > 0);
      const kept = lines.filter(line => {
        try {
          return (JSON.parse(line) as Episode).run_id !== runId;
        } catch {
          return true;
        }
      });
      if (kept.length === lines.length) return;
      if (kept.length === 0) {
        await fs.rm(file, { force: true });
      } else {
        await writeAtomic(file, `${kept.join("\n")}\n`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
