import type { LLMCallManager, LLMMessage } from "./llm.js";
import type { AgentReply } from "./types.js";

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<{ type: string; severity?: string; summary: string; step_id?: string; payload: Record<string, unknown>; evidence_refs?: string[] }[]>;
}

interface EvidenceIndexReader {
  getIndex(runId: string): Promise<{ refs: { ref: string; kind: string; bytes?: number; available: boolean }[]; key_events: { seq: number; summary: string; evidence_refs: string[] }[] }>;
}

interface MemoryWriter {
  writeEpisode(ep: Record<string, unknown>): Promise<void>;
  writeProfile(profile: Record<string, unknown>): Promise<void>;
  getLatestProfile(targetId: string): Promise<{ final_metrics: Record<string, number> } | null>;
}

interface EventEmitter {
  emit(e: Record<string, unknown>): void;
}

export class ReplyGenerator {
  constructor(
    private llm: LLMCallManager,
    private eventStore: EventStoreReader,
    private evidenceIndex: EvidenceIndexReader,
    private memory: MemoryWriter,
    private eb: EventEmitter,
    private dataRoot = ".embed-agent",
  ) {}

  // --- Normal generation (LLM) ---

  async generate(runId: string): Promise<AgentReply> {
    const [events, evidence] = await Promise.all([
      this.eventStore.read(runId),
      this.evidenceIndex.getIndex(runId),
    ]);

    const fatalEvents = events.filter(e => e.severity === "fatal");
    const warnings = events.filter(e => e.severity === "warning");
    const status: AgentReply["status"] = fatalEvents.length > 0 ? "failed" : "completed";

    const staticPrompt = `You are an Embed Agent Reply Generator. Given the events and evidence from a validation run, produce a concise summary of findings.

Output JSON:
{
  "summary": "<2-3 sentence summary of key findings>",
  "suggested_next": "<what to do next>",
  "key_evidence": [{ "summary": "<finding>", "evidence_refs": ["ref1"] }],
  "confidence": 0.0-1.0
}`;

    const messages: LLMMessage[] = [
      { role: "system", content: staticPrompt },
      { role: "user", content: JSON.stringify({
        events: events.slice(0, 100).map(e => ({ type: e.type, severity: e.severity, summary: e.summary })),
        fatal_count: fatalEvents.length,
        warning_count: warnings.length,
        key_events: evidence.key_events,
      }, null, 2) },
    ];

    let reply: AgentReply;

    try {
      const result = await this.llm.call("reply", messages);

      if ("status" in result) {
        // CB4 degraded — rule-based summary
        reply = this.buildMinimal(runId, status, "LLM degraded — rule-based summary");
      } else {
        reply = this.parseReply(runId, status, result.content);
      }
    } catch {
      reply = this.buildMinimal(runId, status, "LLM failed — rule-based summary");
    }

    // Write memory artifacts (always, even on LLM failure)
    await this.writeArtifacts(runId, reply, events);

    // Reply is the ONLY publisher of result_ready
    this.eb.emit({
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

  async generateMinimal(runId: string, reason: string): Promise<AgentReply> {
    const reply = this.buildMinimal(runId, "failed", reason);
    await this.writeArtifacts(runId, reply, []);
    this.eb.emit({
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

  async generateCancelled(runId: string, reason: string): Promise<AgentReply> {
    const reply: AgentReply = {
      run_id: runId,
      status: "cancelled",
      summary: reason,
      suggested_next: "re-run with corrected parameters",
      evidence_path: `${this.dataRoot}/runs/${runId}`,
      key_evidence: [],
      confidence: 1.0,
    };
    await this.writeArtifacts(runId, reply, []);
    this.eb.emit({
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

  private async writeArtifacts(
    runId: string,
    reply: AgentReply,
    events: { type: string; severity?: string; summary: string; step_id?: string }[],
  ): Promise<void> {
    const episode = {
      episode_id: `ep-${runId}`,
      run_id: runId,
      target_id: "", // filled by caller via different path
      artifact_ref: "",
      task: "",
      result: reply.status,
      summary: reply.summary,
      key_evidence: reply.key_evidence,
      suggestions: [reply.suggested_next],
      pitfalls: events.filter(e => e.severity === "fatal").map(e => e.summary),
      recorded_at: new Date().toISOString(),
    };

    const profile = {
      run_id: runId,
      target_id: "",
      artifact: { path: "", type: "" },
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
    ]).catch(() => { /* memory write failure is non-fatal */ });
  }
}
