export interface Step {
  id: string;
  capability: string;
  action: "exec" | "stream" | "push" | "flash" | "wait";
  command?: string;
  timeout_sec: number;
  retry_policy?: { max_retries: number; intervals_sec: number[] };
  condition?: string;
}

export interface Decision {
  decision: "stop" | "continue" | "collect_more" | "extend_wait" | "pause" | "suggest" | "observe_more_frequent" | "observe_again_at";
  reason: string;
  confidence: number;
  reasoning_trace: string;
  evidence_refs: string[];
  params?: {
    extra_wait_sec?: number;
    logs?: string[];
    observe_interval?: number;
    observe_at?: number;
  };
  suggestion?: string;
}

export interface AgentReply {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  suggested_next: string;
  evidence_path: string;
  key_evidence: { summary: string; evidence_refs: string[] }[];
  confidence: number;
}
