import type { RunManager } from "./run-manager.js";

interface RunStoreReader {
  get(runId: string): Promise<{ state: string } | null>;
}

interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

export interface Task {
  name: string;
  cron?: string;
  watch_path?: string;
  skill: string;
  params?: Record<string, string>;
  target: string;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  expected: string;
  last_run?: { run_id: string; state: string };
}

const NON_TERMINAL = ["planning", "running", "paused", "collecting_evidence", "finalizing"];

export class TaskManager {
  constructor(
    private rm: RunManager,
    private runStore: RunStoreReader,
    private eb: EventEmitter,
  ) {}

  async onCronTrigger(task: Task): Promise<string | null> {
    // Check if previous run is still active
    if (task.last_run?.run_id) {
      const prev = await this.runStore.get(task.last_run.run_id);
      if (prev && NON_TERMINAL.includes(prev.state)) {
        this.eb.emit({
          type: "skipped_run", source: "task_manager",
          summary: `Task "${task.name}" skipped: previous run still ${prev.state}`,
          payload: { task: task.name, previous_run: task.last_run.run_id, state: prev.state },
        });
        return null;
      }
    }

    // Create new run via RunManager
    const result = await this.rm.createRun({
      artifact: task.artifact,
      target: task.target,
      expected: task.expected,
      constraints: {},
    });

    if (result.run_id) {
      task.last_run = { run_id: result.run_id, state: "planning" };
      return result.run_id;
    }

    return null;
  }
}
