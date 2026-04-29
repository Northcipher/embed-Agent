export type TaskTriggerType = "cron" | "event" | "continuous";

export interface Task {
  task_id: string;
  name: string;
  trigger: {
    type: TaskTriggerType;
    cron?: string;
    path?: string;
    duration_sec?: number;
  };
  skill: string;
  params: Record<string, string>;
  enabled: boolean;
  last_run?: {
    run_id: string;
    state: string;
  };
  next_trigger_at?: string;
  created_at: string;
  updated_at: string;
}
