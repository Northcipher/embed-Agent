const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export interface Target {
  target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string;
}

export interface RunEvent {
  seq: number; type: string; severity?: string; summary: string; time: string; step_id?: string; payload?: Record<string, unknown>; evidence_refs?: string[];
}

export interface RunStatus {
  run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; last_event_seq: number; evidence_path: string;
}

export interface RunResult {
  run_id: string; state: string; result_available: boolean; summary?: string; suggested_next?: string;
  key_evidence?: { summary: string; evidence_refs: string[] }[];
  criteria_results?: { criterion: string; status: string; evidence_refs: string[] }[];
}

export const api = {
  targets: () => req<Target[]>("/targets"),
  targetCaps: (id: string) => req<{ target: string; runtime_state: Record<string, unknown>; capabilities: string[] }>(`/targets/${encodeURIComponent(id)}/capabilities`),
  history: (target: string, limit?: number) => req<{ episode_id: string; result: string; summary: string }[]>(`/targets/${encodeURIComponent(target)}/history${limit ? `?limit=${limit}` : ""}`),
  validate: (body: Record<string, unknown>) => req<{ status: string; run_id?: string; reasons?: string[] }>("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  status: (runId: string) => req<RunStatus | null>(`/runs/${encodeURIComponent(runId)}/status`),
  events: (runId: string, after?: number, limit?: number) => req<{ events: RunEvent[]; next_after_seq: number; has_more: boolean }>(`/runs/${encodeURIComponent(runId)}/events?after_seq=${after ?? 0}&limit=${limit ?? 100}`),
  result: (runId: string) => req<RunResult>(`/runs/${encodeURIComponent(runId)}/result`),
  evidence: (runId: string, ref?: string) => req<{ index?: { refs: { ref: string; kind: string; bytes?: number }[] }; content?: string; available: boolean }>(`/runs/${encodeURIComponent(runId)}/evidence${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
  intervene: (runId: string, action: string, reason?: string, extra?: Record<string, unknown>) => req("/runs/" + encodeURIComponent(runId) + "/interventions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, reason: reason ?? "manual", ...extra }) }),
};
