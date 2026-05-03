// Simple task store — JSON file CRUD for scheduled validation tasks.
import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";

export interface TaskRecord {
  name: string;
  cron: string;          // cron expression e.g. "0 2 * * *"
  target: string;
  artifactPath: string;
  artifactType: string;
  expected: string;
  enabled: boolean;
  lastRun?: string;      // ISO timestamp
  lastRunId?: string;    // run_id of last execution
  createdAt: string;
}

export class TaskStore {
  constructor(private dataRoot: string) {}

  private filePath(): string {
    return path.join(this.dataRoot, "tasks.json");
  }

  async list(): Promise<TaskRecord[]> {
    try {
      const data = await fs.readFile(this.filePath(), "utf-8");
      return JSON.parse(data) as TaskRecord[];
    } catch { return []; }
  }

  async add(task: TaskRecord): Promise<void> {
    const tasks = await this.list();
    const existing = tasks.findIndex(t => t.name === task.name);
    if (existing >= 0) tasks[existing] = task;
    else tasks.push(task);
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
  }

  async remove(name: string): Promise<void> {
    const tasks = (await this.list()).filter(t => t.name !== name);
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
  }

  async updateLastRun(name: string, runId: string): Promise<void> {
    const tasks = await this.list();
    const t = tasks.find(t => t.name === name);
    if (t) { t.lastRun = new Date().toISOString(); t.lastRunId = runId; }
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
  }
}
