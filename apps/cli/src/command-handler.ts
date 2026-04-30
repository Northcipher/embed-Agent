import type { ValidateRequest } from "@embed-agent/runtime";

interface RunManagerLike {
  createRun(req: ValidateRequest): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }>;
  pause(runId: string, reason: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
}

interface ViewsLike {
  status(runId: string): Promise<{ run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number } | null>;
  events(runId: string, afterSeq?: number, limit?: number, types?: string[]): Promise<{ events: { seq: number; type: string; severity?: string; summary: string; time: string }[]; next_after_seq: number; has_more: boolean }>;
  result(runId: string): Promise<{ run_id: string; state: string; result_available: boolean; summary?: string; suggested_next?: string; evidence_path?: string; key_evidence?: { summary: string; evidence_refs: string[] }[] }>;
  evidence(runId: string, ref?: string): Promise<{ available: boolean; index?: { refs: { ref: string; kind: string }[] } }>;
  targets(): Promise<{ target_id: string; state: string; current_run_id?: string }[]>;
  history(targetId: string, limit?: number): Promise<{ episode_id: string; result: string; summary: string }[]>;
}

export class CommandHandler {
  constructor(
    private rm: RunManagerLike,
    private views: ViewsLike,
  ) {}

  // --- Validation & Execution ---

  async validate(req: ValidateRequest): Promise<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }> {
    return this.rm.createRun(req);
  }

  // --- Query ---

  async status(runId: string) { return this.views.status(runId); }
  async events(runId: string, afterSeq?: number, limit?: number, types?: string[]) { return this.views.events(runId, afterSeq, limit, types); }
  async result(runId: string) { return this.views.result(runId); }
  async evidence(runId: string, ref?: string) { return this.views.evidence(runId, ref); }
  async targetList() { return this.views.targets(); }
  async history(targetId: string, limit?: number) { return this.views.history(targetId, limit); }

  // --- Intervention ---

  async pause(runId: string, reason = "manual"): Promise<{ accepted: boolean; run_id: string }> {
    try { await this.rm.pause(runId, reason); return { accepted: true, run_id: runId }; }
    catch { return { accepted: false, run_id: runId }; }
  }

  async resume(runId: string): Promise<{ accepted: boolean; run_id: string }> {
    try { await this.rm.resume(runId); return { accepted: true, run_id: runId }; }
    catch { return { accepted: false, run_id: runId }; }
  }

  async cancel(runId: string, reason = "manual"): Promise<{ accepted: boolean; run_id: string; status: string }> {
    try { await this.rm.cancel(runId, reason); return { accepted: true, run_id: runId, status: "cancelling" }; }
    catch { return { accepted: false, run_id: runId, status: "error" }; }
  }
}
