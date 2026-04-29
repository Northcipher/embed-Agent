import type { Task } from "@embed-agent/contracts";
import type { TaskStore } from "@embed-agent/stores";
import type { EventBus } from "./event-bus.js";

export class TaskManager {
  constructor(
    private taskStore: TaskStore,
    private eventBus: EventBus,
  ) {}

  async create(task: Task): Promise<void> { await this.taskStore.create(task); }
  async list(): Promise<Task[]> { return this.taskStore.list(); }
  async get(id: string): Promise<Task | null> { return this.taskStore.get(id); }
  async pause(name: string): Promise<void> {
    const tasks = await this.taskStore.list();
    const t = tasks.find(t => t.name === name);
    if (t) await this.taskStore.update(t.task_id, { enabled: false });
  }
  async resume(name: string): Promise<void> {
    const tasks = await this.taskStore.list();
    const t = tasks.find(t => t.name === name);
    if (t) await this.taskStore.update(t.task_id, { enabled: true });
  }
  async delete(id: string): Promise<void> { await this.taskStore.delete(id); }
}
