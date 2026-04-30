import fs from "node:fs/promises";
import path from "node:path";
import type { LLMCallManager, LLMMessage } from "./llm.js";
import type { AgentReply } from "./types.js";

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<{ type: string; severity?: string; summary: string; step_id?: string; payload: Record<string, unknown>; evidence_refs?: string[] }[]>;
}

interface EvidenceIndexReader {
  getIndex(runId: string): Promise<{ refs: { ref: string; kind: string; bytes?: number; available: boolean }[]; key_events: { seq: number; summary: string; evidence_refs: string[] }[] }>;
}

interface RunStoreReader {
  get(runId: string): Promise<{ target_id: string; artifact: { path: string; type: string; version?: string; build_id?: string }; evidence_root: string } | null>;
}

interface MemoryWriter {
  writeEpisode(ep: Record<string, unknown>): Promise<void>;
  writeProfile(profile: Record<string, unknown>): Promise<void>;
  getLatestProfile(targetId: string): Promise<{ final_metrics: Record<string, number> } | null>;
}

interface EventEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

interface RunInfo {
  target_id: string;
  artifact: { path: string; type: string; version?: string; build_id?: string };
  task?: string;
}

// Failure event types that indicate a failed run
// decision_made is NOT a failure signal — it's an audit event for any Observer decision
const FAILURE_TYPES = new Set(["step_failed", "run_failed"]);

export class ReplyGenerator {
  constructor(
    private llm: LLMCallManager,
    private eventStore: EventStoreReader,
    private evidenceIndex: EvidenceIndexReader,
    private runStore: RunStoreReader,
    private memory: MemoryWriter,
    private eb: EventEmitter,
    private dataRoot = ".embed-agent",
  ) {}

  // --- Normal generation (LLM) ---

  async generate(runId: string): Promise<AgentReply> {
    const [events, evidence, run] = await Promise.all([
      this.eventStore.read(runId),
      this.evidenceIndex.getIndex(runId),
      this.runStore.get(runId),
    ]);

    const status = this.determineStatus(events);

    const staticPrompt = `You are an Embed Agent Reply Generator. Given the events and evidence from a validation run, produce a concise summary of findings.

Output JSON:
{
  "summary": "<2-3 sentence summary of key findings>",
  "suggested_next": "<what to do next>",
  "key_evidence": [{ "summary": "<finding>", "evidence_refs": ["ref1"] }],
  "confidence": 0.0-1.0
}`;

    // Select most relevant events for LLM: last 50 + all fatal/warning/decision events
    const importantEvents = events.filter(e => e.severity === "fatal" || e.severity === "warning" || e.type === "decision_made" || e.type === "result_ready");
    const recentEvents = events.slice(-50);
    const combined = new Map<string, { type: string; severity?: string; summary: string }>();
    for (const e of [...importantEvents, ...recentEvents]) {
      const item: { type: string; severity?: string; summary: string } = { type: e.type, summary: e.summary };
      if (e.severity) item.severity = e.severity;
      combined.set(`${e.type}-${e.summary}`, item);
    }

    // Extract success criteria from plan_generated event
    const planEvent = events.find(e => e.type === "run_started");
    const planPayload = (planEvent?.payload ?? {}) as Record<string, unknown>;

    const messages: LLMMessage[] = [
      { role: "system", content: staticPrompt },
      { role: "user", content: JSON.stringify({
        events: [...combined.values()],
        fatal_count: events.filter(e => e.severity === "fatal").length,
        failure_events: events.filter(e => FAILURE_TYPES.has(e.type)).map(e => e.type),
        key_events: evidence.key_events,
        success_criteria: planPayload.success_criteria ?? [],
        failure_signals: planPayload.failure_signals ?? [],
      }, null, 2) },
    ];

    let reply: AgentReply;

    try {
      const result = await this.llm.call("reply", messages);

      if ("status" in result) {
        reply = this.buildMinimal(runId, status, "LLM degraded — rule-based summary");
      } else {
        reply = this.parseReply(runId, status, result.content);
      }
    } catch (e) {
      console.error(`[ReplyGenerator] LLM call failed for ${runId}:`, (e as Error).message);
      reply = this.buildMinimal(runId, status, "LLM failed — rule-based summary");
    }

    // Persist reply.json before emitting result_ready
    await this.persistReply(runId, reply);

    // Write memory artifacts (always, even on LLM failure)
    await this.writeArtifacts(runId, reply, events, run ? { target_id: run.target_id, artifact: run.artifact } : undefined);

    // Reply is the ONLY publisher of result_ready
    await this.eb.emit({
      type: "result_ready", run_id: runId, source: "reply_generator",
      summary: reply.summary,
      payload: {
        status: reply.status, summary: reply.summary,
        suggested_next: reply.suggested_next,
        evidence_path: reply.evidence_path,
        key_evidence: reply.key_evidence,
        confidence: reply.confidence,
      },
    });

    return reply;
  }

  // --- Minimal generation (rule-based, for early failures) ---

  async generateMinimal(runId: string, reason: string, runInfo?: RunInfo): Promise<AgentReply> {
    const reply = this.buildMinimal(runId, "failed", reason);
    await this.persistReply(runId, reply);
    await this.writeArtifacts(runId, reply, [], runInfo);
    await this.eb.emit({
      type: "result_ready", run_id: runId, source: "reply_generator",
      summary: reply.summary,
      payload: {
        status: reply.status, summary: reply.summary,
        suggested_next: reply.suggested_next,
        evidence_path: reply.evidence_path,
        key_evidence: reply.key_evidence,
        confidence: reply.confidence,
      },
    });
    return reply;
  }

  // --- Cancelled generation (rule-based) ---

  async generateCancelled(runId: string, reason: string, runInfo?: RunInfo): Promise<AgentReply> {
    const reply: AgentReply = {
      run_id: runId,
      status: "cancelled",
      summary: reason,
      suggested_next: "re-run with corrected parameters",
      evidence_path: `${this.dataRoot}/runs/${runId}`,
      key_evidence: [],
      confidence: 1.0,
    };
    await this.persistReply(runId, reply);
    await this.writeArtifacts(runId, reply, [], runInfo);
    await this.eb.emit({
      type: "result_ready", run_id: runId, source: "reply_generator",
      summary: reply.summary,
      payload: {
        status: reply.status, summary: reply.summary,
        suggested_next: reply.suggested_next,
        evidence_path: reply.evidence_path,
        key_evidence: reply.key_evidence,
        confidence: reply.confidence,
      },
    });
    return reply;
  }

  // --- Private ---

  private determineStatus(events: { type: string; severity?: string }[]): AgentReply["status"] {
    const hasFatal = events.some(e => e.severity === "fatal");
    const hasFailure = events.some(e => FAILURE_TYPES.has(e.type));
    if (hasFatal || hasFailure) return "failed";
    return "completed";
  }

  private parseReply(runId: string, status: AgentReply["status"], content: string): AgentReply {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
      const parsed = JSON.parse(json);
      return {
        run_id: runId,
        status,
        summary: parsed.summary ?? "Validation completed",
        suggested_next: parsed.suggested_next ?? "review evidence",
        evidence_path: `${this.dataRoot}/runs/${runId}`,
        key_evidence: parsed.key_evidence ?? [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      };
    } catch {
      return this.buildMinimal(runId, status, "Failed to parse LLM reply");
    }
  }

  private buildMinimal(runId: string, status: AgentReply["status"], reason: string): AgentReply {
    return {
      run_id: runId,
      status,
      summary: reason,
      suggested_next: "check evidence manually",
      evidence_path: `${this.dataRoot}/runs/${runId}`,
      key_evidence: [],
      confidence: 0.5,
    };
  }

  private async persistReply(runId: string, reply: AgentReply): Promise<void> {
    try {
      const dir = path.join(this.dataRoot, "runs", runId, "brain");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "reply.json"), JSON.stringify(reply, null, 2), "utf-8");
    } catch (e) { console.error(`[ReplyGenerator] Failed to persist reply:`, (e as Error).message); }
  }

  private async writeArtifacts(
    runId: string,
    reply: AgentReply,
    events: { type: string; severity?: string; summary: string; step_id?: string }[],
    runInfo?: RunInfo,
  ): Promise<void> {
    const episode = {
      episode_id: `ep-${runId}`,
      run_id: runId,
      target_id: runInfo?.target_id ?? "",
      artifact_ref: runInfo?.artifact?.path ?? "",
      task: runInfo?.task ?? "",
      result: reply.status,
      summary: reply.summary,
      key_evidence: reply.key_evidence,
      suggestions: [reply.suggested_next],
      pitfalls: events.filter(e => e.severity === "fatal").map(e => e.summary),
      recorded_at: new Date().toISOString(),
    };

    const profile = {
      run_id: runId,
      target_id: runInfo?.target_id ?? "",
      artifact: runInfo?.artifact ?? { path: "", type: "" },
      result: reply.status,
      stage_durations: [] as { stage: string; duration: number }[],
      final_metrics: {} as Record<string, number>,
      output_summary: {
        total_lines: events.length,
        peak_lines_per_sec: 0,
        silence_count: 0,
        rule_hits: {} as Record<string, number>,
      },
      recorded_at: new Date().toISOString(),
    };

    await Promise.all([
      this.memory.writeEpisode(episode),
      this.memory.writeProfile(profile),
    ]).catch((e) => { console.error(`[ReplyGenerator] Memory write failed:`, (e as Error).message); });
  }
}
