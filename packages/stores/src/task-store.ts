import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";

export interface TaskRecord {
  name: string;
  cron?: string;
  watch_path?: string;
  skill: string;
  params?: Record<string, string>;
  target: string;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  expected: string;
  enabled: boolean;
  last_run?: { run_id: string; state: string; at: string };
  created_at: string;
  updated_at: string;
}

export class TaskStore {
  constructor(private dataRoot = ".embed-agent") {}

  private tasksFile(): string {
    return path.join(this.dataRoot, "tasks.json");
  }

  private async readAll(): Promise<TaskRecord[]> {
    try {
      const content = await fs.readFile(this.tasksFile(), "utf-8");
      return JSON.parse(content) as TaskRecord[];
    } catch {
      return [];
    }
  }

  private async writeAll(tasks: TaskRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.tasksFile()), { recursive: true });
    await writeAtomic(this.tasksFile(), JSON.stringify(tasks, null, 2));
  }

  async create(task: TaskRecord): Promise<void> {
    const tasks = await this.readAll();
    if (tasks.some(t => t.name === task.name)) {
      throw new Error(`Task already exists: ${task.name}`);
    }
    tasks.push({ ...task, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await this.writeAll(tasks);
  }

  async get(name: string): Promise<TaskRecord | null> {
    const tasks = await this.readAll();
    return tasks.find(t => t.name === name) ?? null;
  }

  async update(name: string, patch: Partial<TaskRecord>): Promise<void> {
    const tasks = await this.readAll();
    const idx = tasks.findIndex(t => t.name === name);
    if (idx < 0) throw new Error(`Task not found: ${name}`);
    tasks[idx] = { ...tasks[idx]!, ...patch, updated_at: new Date().toISOString() };
    await this.writeAll(tasks);
  }

  async updateLastRun(name: string, runId: string, state: string): Promise<void> {
    await this.update(name, { last_run: { run_id: runId, state, at: new Date().toISOString() } });
  }

  async list(): Promise<TaskRecord[]> {
    return this.readAll();
  }

  async remove(name: string): Promise<void> {
    const tasks = await this.readAll();
    await this.writeAll(tasks.filter(t => t.name !== name));
  }
}
