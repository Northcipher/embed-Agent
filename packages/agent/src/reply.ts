/**
 * ReplyGenerator v2 — multi-pass per-criterion evaluation.
 *
 * Phase 1: Per-Criterion Evaluation (parallel Promise.all)
 *   Each success criterion gets an independent, focused LLM call.
 *   The model evaluates ONE criterion against all available evidence.
 *   Output is collected via submitCriterionResult tool or text fallback.
 *
 * Phase 2: Synthesis
 *   All per-criterion results are combined with the run summary
 *   into a final reply via the submitReply tool.
 *
 * Falls back to single-pass when: no criteria defined, only 1 criterion,
 * or the per-criterion phase fails.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LLMCallManager } from "./llm.js";
import type { AgentReply } from "./types.js";
import { Agent, type AgentConfig } from "./agent.js";
import { submitReplyTool, submitCriterionResultTool, type SubmitReplyInput, type SubmitCriterionResultInput } from "./output-tools.js";

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

const FAILURE_TYPES = new Set(["step_failed", "run_failed"]);

// Per-criterion evaluation prompt — focused, single-task
const CRITERION_EVAL_PROMPT = `You are evaluating ONE success criterion for a device validation run.

You will be given the run events, evidence content, and the single criterion to evaluate.
Focus ONLY on this criterion. Ignore other criteria.

Determine:
- pass: evidence directly confirms this criterion
- fail: evidence contradicts this criterion, or a failure signal matches
- unknown: insufficient or irrelevant evidence to determine

Use the submitCriterionResult tool to output your evaluation. Reference specific evidence_refs.`;

// Synthesis prompt — combines per-criterion results into final reply
const SYNTHESIS_PROMPT = `You are an Embed Agent Reply Generator. The run status is PRE-DETERMINED by the system.

You will receive per-criterion evaluation results that other evaluators have produced.
Your job: synthesize these into a cohesive final reply.

- Write a 2-4 sentence summary covering what was expected, what happened, and key findings
- Preserve all per-criterion results in your output
- Select 2-5 key evidence findings that best support the overall evaluation
- Provide a concrete, actionable suggested next step
- Calibrate confidence based on evidence completeness

Use the submitReply tool to output the final reply.`;

const DEFAULT_REPLY_PROMPT = SYNTHESIS_PROMPT;

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

  // ============================================================
  // Normal generation — multi-pass per-criterion evaluation
  // ============================================================

  async generate(runId: string): Promise<AgentReply> {
    const [events, evidence, run] = await Promise.all([
      this.eventStore.read(runId, 0, 100000), // large limit to capture all events
      this.evidenceIndex.getIndex(runId),
      this.runStore.get(runId),
    ]);

    // Status determined later after criteria evaluation, but pre-compute events-only status
    const eventStatus = this.determineStatus(events);
    const planEvent = events.find(e => e.type === "run_started");
    const planPayload = (planEvent?.payload ?? {}) as Record<string, unknown>;
    const criteria = (planPayload.success_criteria as string[]) ?? [];

    // Load baseline for comparison
    const targetId = run?.target_id ?? "";
    const baseline = targetId ? await this.memory.getLatestProfile(targetId).catch(() => null) : null;

    // Build shared context for per-criterion evaluation
    const sharedContext = this.buildSharedContext(events, evidence, planPayload);

    // Read evidence content (shared across all criterion evaluations)
    const evidenceContent = await this.readEvidenceContent(runId, evidence);

    // Phase 1: Per-criterion evaluation (parallel)
    let criteriaResults: {
      criterion: string; status: "pass" | "fail" | "unknown";
      confidence: number; reasoning: string; evidence_refs: string[];
    }[] = [];

    if (criteria.length >= 2) {
      // Multi-pass: evaluate each criterion independently
      try {
        const results = await Promise.all(
          criteria.map(c => this.evaluateCriterion(runId, c, evidenceContent, sharedContext)),
        );
        criteriaResults = results;
      } catch {
        // Multi-pass failed — fall through to single-pass below
        criteriaResults = [];
      }
    }

    let reply: AgentReply;

    if (criteriaResults.length > 0) {
      // Phase 2: Synthesis — combine per-criterion results into final reply.
      // Final status considers both events AND criteria evaluation.
      const finalStatus = this.determineStatus(events, criteriaResults);
      reply = await this.synthesize(runId, finalStatus, criteriaResults, sharedContext, baseline);
    } else {
      // Single-pass fallback: one LLM call does everything
      const singlePassEvidence = evidenceContent || await this.readEvidenceContent(runId, evidence);
      reply = await this.singlePassGenerate(runId, eventStatus, events, evidence, planPayload, singlePassEvidence);
    }

    await this.persistReply(runId, reply);
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

  // ============================================================
  // Per-criterion evaluation
  // ============================================================

  private async evaluateCriterion(
    runId: string,
    criterion: string,
    evidenceContent: string,
    sharedContext: string,
  ): Promise<{ criterion: string; status: "pass" | "fail" | "unknown"; confidence: number; reasoning: string; evidence_refs: string[] }> {
    const context = [
      `## Criterion to Evaluate`,
      `**${criterion}**`,
      "",
      sharedContext,
      "",
      evidenceContent,
    ].join("\n");

    const config: AgentConfig<{ criterion: string; status: "pass" | "fail" | "unknown"; confidence: number; reasoning: string; evidence_refs: string[] }> = {
      parse: (content: string) => {
        try {
          const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
          const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
          const p = JSON.parse(json) as Record<string, unknown>;
          return {
            criterion: (p.criterion as string) ?? criterion,
            status: (p.status as "pass" | "fail" | "unknown") ?? "unknown",
            confidence: typeof p.confidence === "number" ? p.confidence : 0.5,
            reasoning: (p.reasoning as string) ?? (p.reason as string) ?? "",
            evidence_refs: (p.evidence_refs as string[]) ?? [],
          };
        } catch {
          return { criterion, status: "unknown", confidence: 0.3, reasoning: "Parse failed", evidence_refs: [] };
        }
      },
      fallback: () => ({ criterion, status: "unknown", confidence: 0.3, reasoning: "LLM unavailable", evidence_refs: [] }),
      outputTool: {
        name: "submitCriterionResult",
        schema: submitCriterionResultTool.inputSchema,
        handler: (args: Record<string, unknown>) => {
          const a = args as SubmitCriterionResultInput;
          return { criterion: a.criterion, status: a.status, confidence: a.confidence, reasoning: a.reasoning, evidence_refs: a.evidence_refs };
        },
      },
      stepCount: 2,
      textFallbackPrefix: 'You are a criterion evaluator. Output ONLY JSON: {"criterion":"<exact>","status":"pass|fail|unknown","confidence":0.0-1.0,"reasoning":"<why>","evidence_refs":["<ref>"]}',
    };

    const agent = new Agent("reply", this.llm, config, this.eb);
    return agent.run(CRITERION_EVAL_PROMPT, context, runId);
  }

  // ============================================================
  // Synthesis — combine per-criterion results
  // ============================================================

  private async synthesize(
    runId: string,
    status: AgentReply["status"],
    criteriaResults: { criterion: string; status: "pass" | "fail" | "unknown"; confidence: number; reasoning: string; evidence_refs: string[] }[],
    sharedContext: string,
    baseline?: { final_metrics: Record<string, number> } | null,
  ): Promise<AgentReply> {
    const baselineSection = baseline?.final_metrics ? [
      "## Baseline Comparison",
      "Compare against the latest successful run on this target:",
      ...Object.entries(baseline.final_metrics).map(([k, v]) => `- ${k}: ${v}`),
      "If the current metrics deviate significantly from baseline, note this in your summary and suggested_next.",
      "",
    ].join("\n") : "";

    const context = [
      `## Run Status (pre-determined)`,
      `Status: **${status}**`,
      "",
      baselineSection,
      "## Per-Criterion Results",
      ...criteriaResults.map(c =>
        `- **${c.status.toUpperCase()}** | ${c.criterion} (confidence: ${c.confidence.toFixed(1)})\n  Reasoning: ${c.reasoning}\n  Evidence: ${c.evidence_refs.join(", ") || "none"}`,
      ),
      "",
      sharedContext,
    ].join("\n");

    const replyConfig: AgentConfig<AgentReply> = {
      parse: (content: string) => this.parseReply(runId, status, content),
      fallback: (reason: string) => this.buildMinimal(runId, status, reason),
      outputTool: {
        name: "submitReply",
        schema: submitReplyTool.inputSchema,
        handler: (args: Record<string, unknown>) => this.toolArgsToReply(runId, status, args as SubmitReplyInput),
      },
      stepCount: 2,
      textFallbackPrefix: 'You are a Reply Generator. Output ONLY JSON, no explanation: {"summary":"<2-4 sentences>","suggested_next":"<action>","key_evidence":[{"summary":"<finding>","evidence_refs":["ref"]}],"criteria_results":[{"criterion":"<exact>","status":"pass|fail|unknown","evidence_refs":["ref"]}],"confidence":0.0-1.0}',
    };

    const replyAgent = new Agent("reply", this.llm, replyConfig, this.eb);
    const reply = await replyAgent.run(SYNTHESIS_PROMPT, context, runId);

    // Preserve per-criterion results even if synthesis didn't include them
    if (!reply.criteria_results || reply.criteria_results.length === 0) {
      reply.criteria_results = criteriaResults.map(c => ({
        criterion: c.criterion,
        status: c.status,
        evidence_refs: c.evidence_refs,
      }));
    }

    return reply;
  }

  // ============================================================
  // Single-pass fallback
  // ============================================================

  private async singlePassGenerate(
    runId: string,
    status: AgentReply["status"],
    events: { type: string; severity?: string; summary: string; step_id?: string; payload: Record<string, unknown>; evidence_refs?: string[] }[],
    evidence: { refs: { ref: string; kind: string; bytes?: number; available: boolean }[]; key_events: { seq: number; summary: string; evidence_refs: string[] }[] },
    planPayload: Record<string, unknown>,
    evidenceContent: string,
  ): Promise<AgentReply> {
    const importantEvents = events.filter(e => e.severity === "fatal" || e.severity === "warning" || e.type === "decision_made" || e.type === "result_ready");
    const recentEvents = events.slice(-50);
    const combined = new Map<string, { type: string; severity?: string; summary: string; step_id?: string }>();
    for (const e of [...importantEvents, ...recentEvents]) {
      const item: { type: string; severity?: string; summary: string; step_id?: string } = { type: e.type, summary: e.summary };
      if (e.severity) item.severity = e.severity;
      if (e.step_id) item.step_id = e.step_id;
      combined.set(`${e.type}-${e.summary}-${e.step_id ?? ""}`, item);
    }

    const context = [
      "## Success Criteria",
      ...((planPayload.success_criteria as string[])?.map(c => `- ${c}`) ?? ["- (none specified)"]),
      "",
      "## Failure Signals",
      ...((planPayload.failure_signals as string[])?.map(s => `- ${s}`) ?? ["- (none specified)"]),
      "",
      "## Goal",
      `Task: validate artifact on device`,
      `Expected: ${(planPayload.expected as string) ?? "device operates normally"}`,
      "",
      "## Run Events",
      `Total: ${events.length}  Fatal: ${events.filter(e => e.severity === "fatal").length}  Failures: ${events.filter(e => FAILURE_TYPES.has(e.type)).map(e => e.type).join(", ") || "none"}`,
      "",
      ...[...combined.values()].map(e => `- [${e.severity ?? "info"}] ${e.type}: ${e.summary}`),
      "",
      ...(evidence.key_events.length > 0 ? ["## Decision Timeline", ...evidence.key_events.map(ke => `- seq=${ke.seq}: ${ke.summary}`), ""] : []),
      "## Available Evidence",
      ...evidence.refs.filter(r => r.available).map(r => `- ${r.ref} (${r.kind}, ${r.bytes ?? "?"} bytes)`),
      "",
      evidenceContent,
    ].join("\n");

    const replyConfig: AgentConfig<AgentReply> = {
      parse: (content: string) => this.parseReply(runId, status, content),
      fallback: (reason: string) => this.buildMinimal(runId, status, reason),
      outputTool: {
        name: "submitReply",
        schema: submitReplyTool.inputSchema,
        handler: (args: Record<string, unknown>) => this.toolArgsToReply(runId, status, args as SubmitReplyInput),
      },
      stepCount: 2,
      textFallbackPrefix: 'You are a Reply Generator. Output ONLY JSON, no explanation: {"summary":"<2-4 sentences>","suggested_next":"<action>","key_evidence":[{"summary":"<finding>","evidence_refs":["ref"]}],"criteria_results":[{"criterion":"<exact>","status":"pass|fail|unknown","evidence_refs":["ref"]}],"confidence":0.0-1.0}',
    };

    const replyAgent = new Agent("reply", this.llm, replyConfig, this.eb);
    return replyAgent.run(this.replyPrompt, context, runId);
  }

  // ============================================================
  // Shared context builder
  // ============================================================

  private buildSharedContext(
    events: { type: string; severity?: string; summary: string; step_id?: string }[],
    evidence: { refs: { ref: string; kind: string; bytes?: number; available: boolean }[] },
    planPayload: Record<string, unknown>,
  ): string {
    const importantEvents = events.filter(e => e.severity === "fatal" || e.severity === "warning" || e.type === "decision_made");
    return [
      "## Run Summary",
      `Events: ${events.length} total, ${events.filter(e => e.severity === "fatal").length} fatal, ${events.filter(e => FAILURE_TYPES.has(e.type)).length} failures`,
      `Expected: ${(planPayload.expected as string) ?? "device operates normally"}`,
      "",
      "## Failure Signals",
      ...((planPayload.failure_signals as string[])?.map(s => `- ${s}`) ?? ["- none"]),
      "",
      "## Key Events",
      ...importantEvents.slice(-30).map(e => `- [${e.severity ?? "info"}] ${e.type}: ${e.summary}`),
      "",
      "## Available Evidence",
      ...evidence.refs.filter(r => r.available).map(r => `- ${r.ref} (${r.kind}, ${r.bytes ?? "?"} bytes)`),
    ].join("\n");
  }

  private async readEvidenceContent(
    runId: string,
    evidence: { refs: { ref: string; kind: string; bytes?: number; available: boolean }[] },
  ): Promise<string> {
    if (!this.evidenceIndex.readContent) return "";

    const priorityKinds = ["log", "window"]; // EvidenceStore kind names
    const availableRefs = evidence.refs.filter(r => r.available);
    const sampleRefs = priorityKinds
      .flatMap(kind => availableRefs.filter(r => r.kind === kind))
      .slice(0, 3);
    if (sampleRefs.length === 0 && availableRefs.length > 0) {
      sampleRefs.push(availableRefs[0]!);
    }

    if (sampleRefs.length === 0) return "";

    const lines: string[] = ["## Evidence Content", ""];
    for (const ref of sampleRefs) {
      const content = await this.evidenceIndex.readContent(runId, ref.ref, 4000);
      if (content) {
        lines.push(`### ${ref.ref} (${ref.kind})`);
        lines.push("```");
        lines.push(content.slice(0, 4000));
        lines.push("```");
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  // ============================================================
  // Minimal + Cancelled (unchanged — rule-based)
  // ============================================================

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

  // ============================================================
  // Private helpers
  // ============================================================

  private determineStatus(events: { type: string; severity?: string }[], criteriaResults?: { status: string }[]): AgentReply["status"] {
    const hasFatal = events.some(e => e.severity === "fatal");
    const hasFailure = events.some(e => FAILURE_TYPES.has(e.type));
    const criteriaFailed = criteriaResults?.some(c => c.status === "fail") ?? false;
    if (hasFatal || hasFailure || criteriaFailed) return "failed";
    return "completed";
  }

  private parseReply(runId: string, status: AgentReply["status"], content: string): AgentReply {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const json = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
      const parsed = JSON.parse(json);
      const reply: AgentReply = {
        run_id: runId, status,
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

  private toolArgsToReply(runId: string, status: AgentReply["status"], args: SubmitReplyInput): AgentReply {
    const reply: AgentReply = {
      run_id: runId, status,
      summary: args.summary,
      suggested_next: args.suggested_next,
      evidence_path: `${this.dataRoot}/runs/${runId}`,
      key_evidence: args.key_evidence,
      confidence: args.confidence,
    };
    if (args.criteria_results?.length) reply.criteria_results = args.criteria_results;
    return reply;
  }

  private buildMinimal(runId: string, status: AgentReply["status"], reason: string): AgentReply {
    return {
      run_id: runId, status,
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
      key_evidence: reply.key_evidence.map(ke => ({ summary: ke.summary, refs: ke.evidence_refs })),
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
