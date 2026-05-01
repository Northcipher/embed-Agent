import fs from "node:fs/promises";
import path from "node:path";
import type { LLMCallManager } from "./llm.js";
import type { AgentReply } from "./types.js";
import { Agent, type AgentConfig } from "./agent.js";

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<{ type: string; severity?: string; summary: string; step_id?: string; payload: Record<string, unknown>; evidence_refs?: string[] }[]>;
}

interface EvidenceIndexReader {
  getIndex(runId: string): Promise<{ refs: { ref: string; kind: string; bytes?: number; available: boolean }[]; key_events: { seq: number; summary: string; evidence_refs: string[] }[] }>;
  readContent?(runId: string, ref: string, maxBytes?: number): Promise<string | null>;
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

const DEFAULT_REPLY_PROMPT = `You are an Embed Agent Reply Generator. The run status (completed/failed/cancelled) is PRE-DETERMINED by the system — you do NOT output it. Your job is the narrative: summary, key evidence, per-criterion evaluation, and suggested next steps.

Evaluate each success criterion against the events and evidence content. Be honest: if evidence contradicts a criterion, mark it fail.

Output JSON:
{
  "summary": "<2-4 sentences: what was expected, what happened, key findings>",
  "suggested_next": "<concrete next action>",
  "key_evidence": [{ "summary": "<finding>", "evidence_refs": ["ref1"] }],
  "criteria_results": [{ "criterion": "<exact criterion>", "status": "pass|fail|unknown", "evidence_refs": ["ref"] }],
  "confidence": 0.0-1.0
}`;

export class ReplyGenerator {
  private replyPrompt: string;

  constructor(
    private llm: LLMCallManager,
    private eventStore: EventStoreReader,
    private evidenceIndex: EvidenceIndexReader,
    private runStore: RunStoreReader,
    private memory: MemoryWriter,
    private eb: EventEmitter,
    private dataRoot = ".embed-agent",
    replyPrompt?: string,
  ) {
    this.replyPrompt = replyPrompt ?? DEFAULT_REPLY_PROMPT;
  }

  // --- Normal generation (LLM) ---

  async generate(runId: string): Promise<AgentReply> {
    const [events, evidence, run] = await Promise.all([
      this.eventStore.read(runId),
      this.evidenceIndex.getIndex(runId),
      this.runStore.get(runId),
    ]);

    const status = this.determineStatus(events);

    // Select most relevant events for LLM: last 50 + all fatal/warning/decision events
    const importantEvents = events.filter(e => e.severity === "fatal" || e.severity === "warning" || e.type === "decision_made" || e.type === "result_ready");
    const recentEvents = events.slice(-50);
    const combined = new Map<string, { type: string; severity?: string; summary: string; step_id?: string }>();
    for (const e of [...importantEvents, ...recentEvents]) {
      const item: { type: string; severity?: string; summary: string; step_id?: string } = { type: e.type, summary: e.summary };
      if (e.severity) item.severity = e.severity;
      if (e.step_id) item.step_id = e.step_id;
      // Include step_id in dedup key to avoid merging events from different steps
      combined.set(`${e.type}-${e.summary}-${e.step_id ?? ""}`, item);
    }

    // Extract success criteria from run_started event
    const planEvent = events.find(e => e.type === "run_started");
    const planPayload = (planEvent?.payload ?? {}) as Record<string, unknown>;

    // Build structured context with primacy/recency ordering:
    // Criteria first (rubric) → Goal → Events → Evidence last (ground truth)
    const context = [
      "## Success Criteria",
      ...( (planPayload.success_criteria as string[])?.map(c => `- ${c}`) ?? ["- (none specified)"] ),
      "",
      "## Failure Signals",
      ...( (planPayload.failure_signals as string[])?.map(s => `- ${s}`) ?? ["- (none specified)"] ),
      "",
      "## Goal",
      `Task: validate artifact on device`,
      `Expected: ${(planPayload.expected as string) ?? "device operates normally"}`,
      "",
      "## Run Events",
      `Total: ${events.length}  Fatal: ${events.filter(e => e.severity === "fatal").length}  Failures: ${events.filter(e => FAILURE_TYPES.has(e.type)).map(e => e.type).join(", ") || "none"}`,
      "",
      ...([...combined.values()].map(e => `- [${e.severity ?? "info"}] ${e.type}: ${e.summary}`)),
      "",
      ...(evidence.key_events.length > 0 ? ["## Decision Timeline", ...evidence.key_events.map(ke => `- seq=${ke.seq}: ${ke.summary}`), ""] : []),
      "## Available Evidence",
      ...(evidence.refs.filter(r => r.available).map(r => `- ${r.ref} (${r.kind}, ${r.bytes ?? "?"} bytes)`)),
    ];

    // Read evidence content samples for the most important refs
    if (this.evidenceIndex.readContent) {
      // Prioritize: serial output, then dmesg, then logcat — up to 3 samples, 2500 chars each
      const priorityKinds = ["serial", "dmesg", "logcat"];
      const availableRefs = evidence.refs.filter(r => r.available);
      const sampleRefs = priorityKinds
        .flatMap(kind => availableRefs.filter(r => r.kind === kind))
        .slice(0, 3);
      if (sampleRefs.length === 0 && availableRefs.length > 0) {
        sampleRefs.push(availableRefs[0]!);
      }

      if (sampleRefs.length > 0) {
        context.push("", "## Evidence Content Samples");
        for (const ref of sampleRefs) {
          const content = await this.evidenceIndex.readContent(runId, ref.ref, 2500);
          if (content) {
            context.push(`### ${ref.ref} (${ref.kind})`);
            context.push("```");
            context.push(content);
            context.push("```");
            context.push("");
          }
        }
      }
    }

    const formattedContext = context.join("\n");

    // Use unified Agent for LLM call — handles parse, fallback, audit
    const replyConfig: AgentConfig<AgentReply> = {
      parse: (content: string) => this.parseReply(runId, status, content),
      fallback: (reason: string) => this.buildMinimal(runId, status, reason),
    };
    const replyAgent = new Agent("reply", this.llm, replyConfig, this.eb);
    const reply = await replyAgent.run(this.replyPrompt, formattedContext, runId);

    // Persist reply.json before emitting result_ready
    await this.persistReply(runId, reply);

    // Write memory artifacts (always, even on LLM failure)
    await this.writeArtifacts(runId, reply, events, run ? { target_id: run.target_id, artifact: run.artifact } : undefined);

    // Reply is the ONLY publisher of result_ready
    const payload: Record<string, unknown> = {
      status: reply.status, summary: reply.summary,
      suggested_next: reply.suggested_next,
      evidence_path: reply.evidence_path,
      key_evidence: reply.key_evidence,
      confidence: reply.confidence,
    };
    if (reply.criteria_results) payload.criteria_results = reply.criteria_results;
    await this.eb.emit({
      type: "result_ready", run_id: runId, source: "reply_generator",
      summary: reply.summary,
      payload,
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
      const reply: AgentReply = {
        run_id: runId,
        status,
        summary: parsed.summary ?? "Validation completed",
        suggested_next: parsed.suggested_next ?? "review evidence",
        evidence_path: `${this.dataRoot}/runs/${runId}`,
        key_evidence: parsed.key_evidence ?? [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      };
      if (parsed.criteria_results && Array.isArray(parsed.criteria_results)) {
        reply.criteria_results = parsed.criteria_results;
      }
      return reply;
    } catch {
      return this.buildMinimal(runId, status, "Failed to parse LLM reply");
    }
  }

  private buildMinimal(runId: string, status: AgentReply["status"], reason: string): AgentReply {
    const reply: AgentReply = {
      run_id: runId,
      status,
      summary: reason,
      suggested_next: "check evidence manually",
      evidence_path: `${this.dataRoot}/runs/${runId}`,
      key_evidence: [],
      confidence: 0.5,
    };
    return reply;
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
