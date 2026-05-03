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
export type AuditEventType = "llm_call";

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
  | NotifyEventType
  | AuditEventType;

export type EventSeverity = "fatal" | "warning" | "info";

export type DecisionSource = "rule" | "observer" | "human" | "fallback";

// --- Typed Event Payloads ---

export interface ResultReadyPayload {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  suggested_next: string;
  evidence_path: string;
  key_evidence: { summary: string; evidence_refs: string[] }[];
  confidence: number;
}

export interface RuleMatchedPayload {
  pattern: string;
  rule_id: string;
}

export interface DecisionMadePayload {
  decision: string;
  confidence: number;
  reasoning_trace: string;
}

export interface TargetStateChangedPayload {
  target_id: string;
  state: string;
  transport?: string;
}

export interface StepStartedPayload {
  capability: string;
  action: string;
}

export interface StepFailedPayload {
  failure_type?: string;
}

export interface CheckpointPayload {
  metrics: Record<string, number>;
  trend?: string;
  /** Raw line counts per sampling window — for model-driven pattern analysis. */
  window_samples?: number[];
  /** Stage transitions observed during this window. */
  stage_transitions?: { stage: string; at_sample: number }[];
  /** Cross-source exec completions with exit codes and timestamps. */
  cross_source_events?: { source: string; exit: number; at_sec: number }[];
}

export interface ObservationPayload {
  lines?: number;
}

export interface LLMCallPayload {
  role: "planner" | "observer" | "reply";
  input_chars: number;
  output_chars: number;
  token_input?: number;
  token_output?: number;
  degraded: boolean;
  fallback: boolean;
  model?: string;
  error?: string;
}

export type EventPayload =
  | ResultReadyPayload
  | RuleMatchedPayload
  | DecisionMadePayload
  | TargetStateChangedPayload
  | StepStartedPayload
  | StepFailedPayload
  | CheckpointPayload
  | ObservationPayload
  | LLMCallPayload
  | Record<string, unknown>;

// --- Event ---

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
  payload: EventPayload;
  evidence_refs?: string[];
}
