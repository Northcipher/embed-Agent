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

// Validate Response
export type ValidateResponse =
  | { status: "accepted"; run_id: string; state: RunState; evidence_path: string }
  | { status: "target_busy"; target_id: string }
  | { status: "artifact_invalid"; reasons: string[] }
  | { status: "clarification_needed"; missing_info: string[]; suggested_next?: string }
  | { status: "plan_rejected"; reasons: string[] }
  | { status: "target_not_found"; target_id: string }
  | { status: "target_not_ready"; target_id: string; failed_checks: { check: string; error: string }[] };

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

// Run Status (for get_run_status)
export interface RunStatus {
  run_id: string;
  state: RunState;
  current_step?: {
    id: string;
    capability: string;
    started_at: string;
    timeout_sec: number;
  };
  target: {
    target_id: string;
    state: string;
    serial: string;
    adb: string;
  };
  elapsed_sec: number;
  last_event_seq: number;
  evidence_path: string;
}
