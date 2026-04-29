// Event Types (all)

export type LifecycleEventType =
  | "run_started"
  | "plan_generated"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_paused"
  | "run_resumed"
  | "result_ready";

export type ObservationEventType =
  | "observation"
  | "target_state_changed"
  | "human_note";

export type RuleEventType =
  | "rule_matched"
  | "step_timeout";

export type PeriodicEventType = "checkpoint";

export type SignalEventType =
  | "correlated"
  | "baseline_diff"
  | "stage_transition";

export type DecisionEventType =
  | "decision_made"
  | "decision_rejected"
  | "suggestion_generated"
  | "rule_ignored"
  | "decision_overridden";

export type EvidenceEventType = "evidence_collected";
export type HookEventType = "hook_executed";
export type TaskEventType = "skipped_run";
export type NotifyEventType = "notification_sent";

export type EventType =
  | LifecycleEventType
  | ObservationEventType
  | RuleEventType
  | PeriodicEventType
  | SignalEventType
  | DecisionEventType
  | EvidenceEventType
  | HookEventType
  | TaskEventType
  | NotifyEventType;

export type EventSeverity = "fatal" | "warning" | "info";

export type DecisionSource = "rule" | "observer" | "human" | "fallback";

export interface Event {
  seq: number;
  run_id?: string;
  time: string;
  elapsed_sec?: number;
  type: EventType;
  severity?: EventSeverity;
  source: string;
  step_id?: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence_refs?: string[];
}
