// Run 状态机
export type RunState =
  | "planning"
  | "running"
  | "paused"
  | "collecting_evidence"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export const NON_TERMINAL_STATES: RunState[] = [
  "planning",
  "running",
  "paused",
  "collecting_evidence",
  "finalizing",
];

export const TERMINAL_STATES: RunState[] = [
  "completed",
  "failed",
  "cancelled",
];

// Validate Request
export interface ValidateRequest {
  context: {
    task: string;
    expected: string;
    concerns?: string[];
    what_changed?: string;
    test_hint?: {
      kind: "adb_shell";
      command: string;
      timeout_sec?: number;
      expected_exit_code?: number;
    };
  };
  artifact: {
    path: string;
    type: string;
    version?: string;
    build_id?: string;
    sha256?: string;
  };
  target: string;
  /** Language for AI-written user-facing replies. Technical identifiers stay unchanged. */
  reply_language?: "zh" | "en";
  constraints?: {
    max_duration_sec?: number;
    allow_flash?: boolean;
    allow_shell_exec?: boolean;
    no_flash?: boolean;
    continuous?: boolean;
    observe_interval?: number;
    observe_metrics?: string[];
  };
}

// Run Record (persisted)
export interface RunRecord {
  run_id: string;
  session_id: string;
  state: RunState;
  target_id: string;
  artifact: {
    path: string;
    type: string;
    version?: string;
    build_id?: string;
  };
  plan_ref?: string;
  current_step_id?: string;
  elapsed_sec: number;
  last_event_seq: number;
  evidence_root: string;
  failure_reason?: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
}

// Agent Reply
export interface AgentReply {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  key_evidence: { summary: string; evidence_refs: string[] }[];
  suggested_next: string;
  evidence_path: string;
  confidence: number;
  /** Per-criterion evaluation: one entry per success_criterion from the plan. */
  criteria_results?: { criterion: string; status: "pass" | "fail" | "unknown"; evidence_refs: string[] }[];
}
