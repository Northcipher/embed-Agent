const BASE = import.meta.env.DEV ? "/api" : "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export interface Target {
  target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string;
}

export interface HealthCheck {
  name: string; status: "ok" | "warn" | "error"; message: string; details?: Record<string, unknown>;
}

export interface HealthReport {
  status: "ok" | "warn" | "error"; checks: HealthCheck[]; generated_at: string;
}

export interface PreflightReport {
  status: "ready" | "warn" | "blocked"; checks: HealthCheck[];
}

export interface LlmCallPayload {
  [key: string]: unknown;
  role: "planner" | "observer" | "reply" | string;
  input_chars: number;
  output_chars: number;
  token_input?: number;
  token_output?: number;
  degraded: boolean;
  fallback: boolean;
  source: string;
  model?: string;
  error?: string;
  input_preview: string;
  messages_preview: { role: string; content: string }[];
  raw_content: string;
}

export interface RunEvent {
  seq: number; type: string; severity?: string; summary: string; time: string; step_id?: string; payload?: Record<string, unknown> | LlmCallPayload; evidence_refs?: string[];
}

export interface RunStatus {
  run_id: string; state: string; current_step?: { id: string }; target_state?: string;
  elapsed_sec: number; last_event_seq: number; evidence_path: string;
  created_at?: string; started_at?: string; ended_at?: string;
}

export interface CriterionResult {
  criterion: string; status: string; evidence_refs: string[];
}

export interface KeyEvidence {
  summary: string; evidence_refs: string[];
}

export interface RunResult {
  run_id: string; state: string; result_available: boolean; summary?: string; suggested_next?: string;
  key_evidence?: KeyEvidence[];
  criteria_results?: CriterionResult[];
  previous_result?: { run_id: string; summary: string } | null;
  target_id?: string; target_state?: string;
  artifact?: { path: string; type: string; version?: string; build_id?: string };
  source?: { kind: "manual" | "task"; task_name?: string; task?: string };
  timing?: { created_at: string; started_at?: string; ended_at?: string; elapsed_sec: number };
  task?: string; expected?: string; plan_id?: string; confidence?: number; failure_signature?: string;
  steps?: {
    id: string; status: "pending" | "running" | "completed" | "failed";
    capability?: string; action?: string; command?: string; timeout_sec?: number;
    started_at?: string; ended_at?: string; exit_code?: number; evidence_refs: string[];
  }[];
  evidence_index?: { ref: string; kind: string; bytes?: number; available: boolean }[];
  missing_evidence_refs?: string[];
  event_summary?: { total: number; warnings: number; fatals: number; interventions: number; llm_calls: number };
  process_summary?: {
    kind: "plan" | "device" | "evidence" | "warning" | "llm" | "result";
    status: "ok" | "warn" | "error" | "info";
    title: string;
    detail: string;
    seq?: number;
    step_id?: string;
    evidence_refs?: string[];
  }[];
  related_history?: {
    episode_id: string; run_id: string; result: string; summary: string; recorded_at?: string; artifact_ref?: string; task?: string;
    state?: string; elapsed_sec?: number; created_at?: string; started_at?: string; ended_at?: string;
  }[];
}

export interface RunSummary {
  run_id: string; target: string; state: string; elapsed_sec: number; summary?: string; created_at?: string;
  started_at?: string; ended_at?: string; artifact_ref?: string; task?: string; recorded_at?: string;
  key_evidence?: { summary: string; refs: string[] }[];
  suggestions?: string[];
  pitfalls?: string[];
}

export interface TargetCapabilities {
  target: string; runtime_state: Record<string, unknown>; capabilities: string[];
}

export type TaskTrigger =
  | { kind: "cron"; cron: string; timezone?: string }
  | { kind: "file_event"; pattern: string }
  | { kind: "continuous" };

export interface ValidationSpec {
  artifact: { path: string; type: string; version?: string; build_id?: string };
  target: string;
  expected: string;
  task?: string;
  reply_language?: "zh" | "en";
  concerns?: string[];
  success_criteria?: string[];
  failure_criteria?: string[];
  constraints?: {
    max_duration_sec?: number;
    allow_flash?: boolean;
    allow_shell_exec?: boolean;
    no_flash?: boolean;
    continuous?: boolean;
  };
}

export interface AutomationTask {
  name: string;
  validation_spec: ValidationSpec;
  trigger: TaskTrigger;
  policy: {
    overlap: "skip_if_target_busy" | "queue_next_run" | "cancel_older_run";
    failure: "notify_and_keep_enabled" | "pause_after_3_failures" | "collect_extra_evidence";
  };
  enabled: boolean;
  lastRun?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TargetProfileInput {
  target_id: string;
  display_name?: string;
  connections: Record<string, unknown>;
  flash?: { method: string; artifact_type: string };
  recovery?: { reboot_method?: string; stable_artifact?: string };
  safety: {
    allow_flash: boolean;
    allow_reboot: boolean;
    allow_shell_exec: boolean;
    allow_power_cycle: boolean;
  };
  target_hints?: Record<string, unknown>;
  skills?: string[];
}

/* ── SSE stream for real-time run events ── */
export function streamEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError?: (err: Error) => void,
): AbortController {
  const controller = new AbortController();
  const url = `${BASE}/runs/${encodeURIComponent(runId)}/events/stream`;

  fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal })
    .then(async (response) => {
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim()) continue;
          const dataParts: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) dataParts.push(line.slice(6));
          }
          const data = dataParts.join("\n");
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as unknown;
            if (isRunEvent(parsed)) onEvent(parsed);
          } catch { /* skip malformed */ }
        }
      }
    })
    .catch((err) => {
      if (err.name !== "AbortError") onError?.(err);
    });

  return controller;
}

function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw["seq"] === "number" && typeof raw["type"] === "string";
}

/* ── Combined history from all targets ── */
export async function fetchAllHistory(): Promise<RunSummary[]> {
  const targets = await api.targets();
  const results: RunSummary[] = [];
  for (const t of targets) {
    try {
      const items = await api.history(t.target_id, 30);
      for (const item of items) {
        const run: RunSummary = {
          run_id: item.run_id,
          target: t.target_id,
          state: item.result ?? item.state ?? "unknown",
          elapsed_sec: item.elapsed_sec ?? 0,
          summary: item.summary ?? "",
        };
        if (item.created_at) run.created_at = item.created_at;
        if (item.started_at) run.started_at = item.started_at;
        if (item.ended_at) run.ended_at = item.ended_at;
        if (item.artifact_ref) run.artifact_ref = item.artifact_ref;
        if (item.task) run.task = item.task;
        if (item.recorded_at) run.recorded_at = item.recorded_at;
        if (item.key_evidence) run.key_evidence = item.key_evidence;
        if (item.suggestions) run.suggestions = item.suggestions;
        if (item.pitfalls) run.pitfalls = item.pitfalls;
        results.push(run);
      }
    } catch { /* target may have no history */ }
  }
  results.sort((a, b) => (b.recorded_at ?? b.run_id).localeCompare(a.recorded_at ?? a.run_id));
  return results;
}

export const api = {
  health: () => req<HealthReport>("/health/full"),
  targets: () => req<Target[]>("/targets"),
  createTarget: (body: TargetProfileInput) => req<{ status: string; target: TargetProfileInput }>("/targets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  deleteTarget: (id: string) => req<{ status: "deleted"; target_id: string }>(`/targets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  targetCaps: (id: string) => req<TargetCapabilities>(`/targets/${encodeURIComponent(id)}/capabilities`),
  history: (target: string, limit?: number) => req<{
    episode_id: string; run_id: string; target_id?: string; artifact_ref?: string; task?: string;
    result: string; state?: string; summary: string; elapsed_sec?: number; recorded_at?: string;
    created_at?: string; started_at?: string; ended_at?: string;
    key_evidence?: { summary: string; refs: string[] }[]; suggestions?: string[]; pitfalls?: string[];
  }[]>(`/targets/${encodeURIComponent(target)}/history${limit ? `?limit=${limit}` : ""}`),
  preflight: (body: Record<string, unknown>) => req<PreflightReport>("/runs/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  validate: (body: Record<string, unknown>) => req<{ status: string; run_id?: string; reasons?: string[] }>("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  status: (runId: string) => req<RunStatus | null>(`/runs/${encodeURIComponent(runId)}/status`),
  events: (runId: string, after?: number, limit?: number) => req<{ events: RunEvent[]; next_after_seq: number; has_more: boolean }>(`/runs/${encodeURIComponent(runId)}/events?after_seq=${after ?? 0}&limit=${limit ?? 100}`),
  result: (runId: string) => req<RunResult>(`/runs/${encodeURIComponent(runId)}/result`),
  evidence: (runId: string, ref?: string) => req<{ index?: { refs: { ref: string; kind: string; bytes?: number }[] }; content?: string; available: boolean }>(`/runs/${encodeURIComponent(runId)}/evidence${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
  intervene: (runId: string, action: string, reason?: string, extra?: Record<string, unknown>) => req(`/runs/${encodeURIComponent(runId)}/interventions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...extra, action, reason: reason ?? "manual" }) }),
  deleteRun: (runId: string) => req<{ status: "deleted"; run_id: string }>(`/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
  tasks: () => req<{ tasks: AutomationTask[] }>("/tasks"),
  createTask: (body: Record<string, unknown>) => req<{ status: string; task: AutomationTask }>("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  runTask: (name: string) => req<{ status: string; run_id?: string; reasons?: string[] }>(`/tasks/${encodeURIComponent(name)}/run`, { method: "POST" }),
  testLlmConfig: () => req<{ status: "ok" | "error"; message: string }>("/config/llm.yml/test", { method: "POST" }),
};
