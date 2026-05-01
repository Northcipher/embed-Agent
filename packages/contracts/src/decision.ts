export type DecisionType =
  | "stop"
  | "continue"
  | "collect_more"
  | "extend_wait"
  | "pause"
  | "resume"
  | "cancel"
  | "ignore_rule"
  | "suggest"
  | "observe_more_frequent"
  | "observe_again_at"
  | "override_decision";

export interface Decision {
  decision: DecisionType;
  reason: string;
  confidence: number;
  reasoning_trace: string;
  evidence_refs: string[];
  params?: {
    extra_wait_sec?: number;
    logs?: string[];
    timeout_sec?: number;
    observe_interval?: number;
    observe_at?: number;
  };
  suggestion?: string;
}
