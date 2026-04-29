export const HOOK_POINTS = [
  "PreRunStart", "PostRunEnd",
  "PreStepExecute", "PostStepComplete", "PostStepFailed",
  "OnStopDecision", "OnFinalizing",
  "RuntimeStart",
] as const;

export type HookPoint = typeof HOOK_POINTS[number];

export interface HookConfig {
  hooks: {
    name: string;
    on: HookPoint;
    match?: Record<string, string>;
    command: string;
    timeout: number;
  }[];
}

export interface HookResult {
  decision: "proceed" | "block" | "retry";
  reason?: string;
  additional_context?: string;
}

export interface HookContext {
  run_id?: string;
  target_id?: string;
  step_id?: string;
  capability?: string;
  state?: string;
  failure_reason?: string;
  evidence_root?: string;
  artifact_path?: string;
}

export interface HookExecutedEvent {
  type: "hook_executed";
  run_id?: string;
  hook_name: string;
  point: HookPoint;
  decision: "proceed" | "block" | "retry";
  duration_ms: number;
  error?: string;
}
