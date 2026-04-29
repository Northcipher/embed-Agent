import fs from "node:fs/promises";
import path from "node:path";
import type { Task } from "@embed-agent/contracts";

export class TaskStore {
  constructor(private dataRoot: string) {}

  private get filePath(): string {
    return path.join(this.dataRoot, "tasks.json");
  }

  private async readAll(): Promise<Task[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(content) as Task[];
    } catch {
      return [];
    }
  }

  private async writeAll(tasks: Task[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(tasks, null, 2), "utf-8");
  }

  async create(task: Task): Promise<void> {
    const tasks = await this.readAll();
    tasks.push(task);
    await this.writeAll(tasks);
  }

  async update(taskId: string, patch: Partial<Task>): Promise<void> {
    const tasks = await this.readAll();
    const idx = tasks.findIndex(t => t.task_id === taskId);
    if (idx >= 0) {
      const updated = { ...tasks[idx], ...patch, updated_at: new Date().toISOString() };
      tasks[idx] = updated as Task;
      await this.writeAll(tasks);
    }
  }

  async get(taskId: string): Promise<Task | null> {
    const tasks = await this.readAll();
    return tasks.find(t => t.task_id === taskId) ?? null;
  }

  async list(): Promise<Task[]> {
    return this.readAll();
  }

  async delete(taskId: string): Promise<void> {
    const tasks = await this.readAll();
    await this.writeAll(tasks.filter(t => t.task_id !== taskId));
  }
}
