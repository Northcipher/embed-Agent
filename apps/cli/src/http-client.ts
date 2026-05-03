import type { ValidateRequest } from "@embed-agent/runtime";
import type { ErrorResult } from "./command-handler.js";

type JsonRecord = Record<string, unknown>;

export class HttpCommandHandler {
  constructor(private baseUrl = "http://127.0.0.1:8787") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new Error(
        `Embed Agent Runtime is not reachable at ${this.baseUrl}. Start the HTTP runtime server, set EMBED_AGENT_SERVER_URL, or use --local-runtime for development. Cause: ${(e as Error).message}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Embed Agent Runtime returned HTTP ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async validate(req: ValidateRequest) {
    return this.request<{ status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[] }>("POST", "/runs", req);
  }

  async status(runId: string) {
    return this.request<{
      run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; last_event_seq: number; evidence_path: string;
    } | null>("GET", `/runs/${encodeURIComponent(runId)}/status`);
  }

  async events(runId: string, afterSeq?: number, limit?: number, types?: string[]) {
    const params = new URLSearchParams();
    if (afterSeq !== undefined) params.set("after_seq", String(afterSeq));
    if (limit !== undefined) params.set("limit", String(limit));
    if (types?.length) params.set("types", types.join(","));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.request<{
      events: { seq: number; type: string; severity?: string; summary: string; time: string; step_id?: string; payload?: JsonRecord; evidence_refs?: string[] }[];
      next_after_seq: number; has_more: boolean;
    }>("GET", `/runs/${encodeURIComponent(runId)}/events${suffix}`);
  }

  async result(runId: string) {
    return this.request<{
      run_id: string; state: string; result_available: boolean; summary?: string; suggested_next?: string; evidence_path?: string;
      key_evidence?: { summary: string; evidence_refs: string[] }[];
      criteria_results?: { criterion: string; status: string; evidence_refs: string[] }[];
    }>("GET", `/runs/${encodeURIComponent(runId)}/result`);
  }

  async evidence(runId: string, ref?: string) {
    const params = new URLSearchParams();
    if (ref) params.set("ref", ref);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.request<{
      index?: { refs: { ref: string; kind: string; bytes?: number }[]; key_events: { seq: number; summary: string }[] };
      content?: string; filePath?: string; size?: number; available: boolean;
    }>("GET", `/runs/${encodeURIComponent(runId)}/evidence${suffix}`);
  }

  async targetList() {
    return this.request<{ target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string }[]>("GET", "/targets");
  }

  async getTargetCapabilities(targetId: string) {
    return this.request<{
      target: string; runtime_state: JsonRecord; capabilities: string[];
    } | ErrorResult>("GET", `/targets/${encodeURIComponent(targetId)}/capabilities`);
  }

  async history(targetId: string, limit?: number) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.request<{ episode_id: string; result: string; summary: string }[]>("GET", `/targets/${encodeURIComponent(targetId)}/history${suffix}`);
  }

  async pause(runId: string, reason = "manual") {
    return this.intervene(runId, { action: "pause", reason }) as Promise<{ accepted: boolean; run_id: string } | ErrorResult>;
  }

  async resume(runId: string) {
    return this.intervene(runId, { action: "resume", reason: "manual" }) as Promise<{ accepted: boolean; run_id: string } | ErrorResult>;
  }

  async cancel(runId: string, reason = "manual") {
    return this.intervene(runId, { action: "cancel", reason }) as Promise<{ accepted: boolean; run_id: string; status: string } | ErrorResult>;
  }

  async addInstruction(runId: string, instruction: string) {
    return this.intervene(runId, { action: "add_instruction", reason: "manual", instruction }) as Promise<{ accepted: boolean; run_id: string; event_seq?: number } | ErrorResult>;
  }

  async ignoreRule(runId: string, ruleId: string) {
    return this.intervene(runId, { action: "ignore_rule", reason: "manual", rule_id: ruleId }) as Promise<{ accepted: boolean; run_id: string } | ErrorResult>;
  }

  async override(runId: string, decision: "continue" | "stop" | "cancel", reason?: string) {
    return this.intervene(runId, { action: "override", reason: reason ?? "manual", decision }) as Promise<{ accepted: boolean; run_id: string; action: string } | ErrorResult>;
  }

  private async intervene(runId: string, body: JsonRecord) {
    return this.request<JsonRecord>("POST", `/runs/${encodeURIComponent(runId)}/interventions`, body);
  }

  async taskList() { return unsupported("Task management is not exposed by the HTTP Runtime API yet"); }
  async taskShow(_name: string) { return unsupported("Task management is not exposed by the HTTP Runtime API yet"); }
  async memoryList(_targetId?: string, _category?: string) { return unsupported("Memory is not exposed by the HTTP Runtime API yet"); }
  async memoryConfirm(_factId?: string) { return unsupported("Fact verification is not exposed by the HTTP Runtime API yet"); }
  async memoryAdd(_targetId: string, _category: string, _statement: string) { return unsupported("Memory writes are not exposed by the HTTP Runtime API yet"); }
  async memoryDelete(_factId: string) { return unsupported("Memory writes are not exposed by the HTTP Runtime API yet"); }
  async skillList() { return unsupported("Skills are not exposed by the HTTP Runtime API yet"); }
  async skillShow(_name: string) { return unsupported("Skill details are not exposed by the HTTP Runtime API yet"); }
  async hookList() { return unsupported("Hooks are not exposed by the HTTP Runtime API yet"); }
  async hookShow(_name: string) { return unsupported("Hook details are not exposed by the HTTP Runtime API yet"); }
}

function unsupported(message: string): ErrorResult {
  return { status: "error", error_code: "unsupported_action", message };
}
