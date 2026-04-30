export type StepAction = "exec" | "stream" | "push" | "flash" | "wait";

export type StepCondition = "always" | "on_failure" | "on_success";
export type StepOnFailure = "stop" | "continue" | "collect_and_stop";

export interface ObserveConfig {
  interval: number;
  metrics: string[];
  trend_window: number;
  sampling_commands: string[];
}

export interface RetryPolicy {
  max_retries: number;
  intervals_sec: number[];
}

export interface Step {
  id: string;
  action: StepAction;
  capability: string;
  command?: string;
  image?: string;
  partition?: string;
  src?: string;
  dst?: string;
  timeout_sec: number;
  condition?: StepCondition;
  on_failure?: StepOnFailure;
  observe?: ObserveConfig;
  retry_policy?: RetryPolicy;
}

export interface Plan {
  plan_id: string;
  estimated_duration_sec: number;
  steps: Step[];
  evidence_policy: {
    always: string[];
    on_failure: string[];
  };
  success_criteria: string[];
  failure_signals: string[];
}
