/**
 * ContextAssembler v2 — builds LLM context per role, cache-aware.
 *
 * Context is the core of the agent. Four explicit layers with cache breakpoints:
 *
 *   [BP1 — Deployment-level]   System Prompt (shared across all runs/targets)
 *   [BP2 — Run-level]          Goal + Known Issues + Evidence Policy (per-run invariant)
 *   [BP3 — Semi-stable]        Working Memory + Decisions + Checkpoint trends (slow growth)
 *   [Uncached — Variable]      Time / Trigger / Evidence / Signals (changes every call)
 *
 * Design principles:
 *   Planner  = generate (primacy) → Goal first, examples in middle, history last.
 *   Observer = discriminate (recency) → Constraints first in variable zone, evidence last.
 *   Reply    = evaluate (primacy) → Criteria rubric first, evidence last.
 *
 * Each method only includes sections that role actually needs.
 */
import type { RunRecord } from "@embed-agent/stores";
import type { EventRecord } from "@embed-agent/stores";

interface RunStoreReader {
  get(runId: string): Promise<RunRecord | null>;
}

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<EventRecord[]>;
}

interface TargetStoreReader {
  get(targetId: string): Promise<{ target_id: string; display_name?: string; target_hints?: Record<string, unknown>; connections: Record<string, unknown> } | null>;
  getState?(targetId: string): Promise<{ serial: string; adb: string; state: string } | null>;
}

interface SkillReader {
  matchTop(task: string, n?: number): { name: string; description: string }[];
  loadMatchedSteps(task: string, n?: number): { name: string; description: string; category: string; steps: { action: string; capability: string; command?: string; timeout_sec: number }[]; evidence: { always: string[]; on_failure: string[] }; success: string[]; failure: string[] }[];
}

interface MemoryReader {
  listByTarget(targetId: string, limit?: number): Promise<{ episode_id: string; summary: string; result: string; key_evidence: { summary: string; refs: string[] }[]; suggestions: string[]; pitfalls: string[] }[]>;
  queryFacts(scope: string, scopeId: string, category?: string, verifiedOnly?: boolean): Promise<{ fact_id: string; category: string; statement: string; verified: boolean; extended_pattern?: string }[]>;
  readWorkingMemory(runId: string): Promise<{ key: string; summary: string; source: string }[]>;
}

interface EvidenceReader {
  readContent(runId: string, ref: string, maxBytes?: number): Promise<string | null>;
}

export interface PlannerContext {
  staticPrompt: string;
  formattedContext: string;
}

export interface ObserverContext {
  staticPrompt: string;
  formattedContext: string;
  /** Known issues matched by keyword — presented as context hints, not decision substitutes. */
  knownIssues?: { fact_id: string; category: string; statement: string; extended_pattern?: string }[] | undefined;
}

// ============================================================
// Minimal fallback prompts — only used when config/prompts/ is unavailable.
// These are intentionally terse: the real prompt comes from versioned .md files.
// ============================================================

const PLANNER_FALLBACK = `You are an Embed Agent Task Planner. Create a concrete, executable validation plan for an embedded device artifact.

## Step Design
Each step needs: id (kebab-case), action (exec|stream|push|flash|wait), capability, timeout_sec.
- serial_output → stream (serial console output)
- shell_exec → exec (device shell via ADB)
- adb_logs → stream (live logcat) or exec (logcat -d dump)
- wait_adb → wait (wait for device to be ready)
- flash → flash (write firmware, command="image:partition")
- push → push (transfer file, command="src:dst")
- collect_logs → exec (dmesg, logcat)
- local_exec → exec (host machine command)
- ssh_exec → exec (device shell via SSH)

## Step Order
1. stream serial_output to observe boot
2. wait_adb after boot
3. shell_exec for verification
4. collect_logs at the end

## Evidence Policy
Minimum: always=["serial:full"], on_failure=["serial:last-window"]
Add dmesg, logcat if applicable.

## Output ONLY valid JSON in the exact format shown below.`;

const OBSERVER_FALLBACK = `You are an Embed Agent Observer. Your role is to decide what action to take when a signal is detected during a validation run.

Available decisions:
- continue — the signal is benign or expected, proceed normally
- collect_more — gather additional evidence before making a final judgment
- collect_evidence — run specific diagnostic commands to get more data
- extend_wait — the device needs more time, extend the current wait
- stop — the signal indicates a real failure, end the run
- pause — the situation needs human attention
- suggest — offer a suggestion but don't change the run state
- observe_more_frequent — increase checkpoint frequency temporarily
- observe_again_at — re-check at a specific future time

You will be given the run goal, known issues for this target, recent decisions, the triggering event, and evidence windows. Evaluate all of this holistically.

Note: CB1 (override breaker) and CB3 (warning escalation) may be active. When active, the system applies additional constraints on your decision AFTER you output it.`;

const REPLY_FALLBACK = `You are an Embed Agent Reply Generator. The run status (completed/failed/cancelled) is pre-determined by the system. Your job is the narrative: summary, key evidence, per-criterion evaluation, and suggested next steps.

Evaluate each success criterion against the events and evidence. Be honest — if evidence contradicts a criterion, mark it fail.

Output via the submitReply tool.`;

// ============================================================
// Helpers
// ============================================================

function h(heading: string, ...lines: string[]): string {
  const body = lines.filter(l => l !== "").join("\n");
  return body.trim() ? `## ${heading}\n${body}\n` : "";
}

function bullets(items: string[]): string {
  return items.map(i => `- ${i}`).join("\n");
}

/** Read evidence content: return full content if ≤ maxBytes, otherwise head + tail to preserve both context and recency. */
async function readEvidenceWindow(
  evidence: EvidenceReader,
  runId: string,
  ref: string,
  maxBytes: number,
): Promise<string> {
  const content = await evidence.readContent(runId, ref, maxBytes + 1);
  if (!content) return "(empty)";
  if (content.length <= maxBytes) return content;
  const headSize = Math.floor(maxBytes * 0.25);
  const tailSize = maxBytes - headSize;
  return content.slice(0, headSize) + `\n... [${content.length - maxBytes} bytes omitted] ...\n` + content.slice(-tailSize);
}

// ============================================================
// ContextAssembler
// ============================================================

export class ContextAssembler {
  private plannerPrompt: string;
  private observerPrompt: string;
  private replyPrompt: string;

  constructor(
    private runStore: RunStoreReader,
    private eventStore: EventStoreReader,
    private targetStore: TargetStoreReader,
    private memory: MemoryReader,
    private evidence?: EvidenceReader,
    private skillRegistry?: SkillReader,
    prompts?: { planner?: string; observer?: string; reply?: string },
  ) {
    this.plannerPrompt = prompts?.planner ?? PLANNER_FALLBACK;
    this.observerPrompt = prompts?.observer ?? OBSERVER_FALLBACK;
    this.replyPrompt = prompts?.reply ?? REPLY_FALLBACK;
  }

  // ============================================================
  // Planner context
  //
  // Goal (primacy) → Constraints → Target → Few-Shot (perturbed) → History (reference)
  // ============================================================

  async assemblePlannerContext(runId: string, taskInfo?: {
    task: string; expected: string; concerns?: string[]; constraints?: Record<string, unknown>; test_hint?: unknown;
  }): Promise<PlannerContext> {
    const run = await this.runStore.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const [target, episodes, facts] = await Promise.all([
      this.targetStore.get(run.target_id),
      this.memory.listByTarget(run.target_id, 5),
      this.memory.queryFacts("target", run.target_id),
    ]);

    const taskDesc = taskInfo?.task ?? (run.artifact.type ? `validate ${run.artifact.type}` : "validate device");

    // Fetch more candidates for perturbation. SkillRegistry implements reservoir sampling internally.
    const skillCandidates = this.skillRegistry?.matchTop(taskDesc, 20) ?? [];
    const tier2 = this.skillRegistry?.loadMatchedSteps(taskDesc, 3) ?? [];

    const sections: string[] = [];

    // --- Goal (primacy) ---
    const goalLines: string[] = [];
    goalLines.push(`**Task**: ${taskInfo?.task ?? `Validate ${run.artifact.type} on ${run.target_id}`}`);
    goalLines.push(`**Expected**: ${taskInfo?.expected ?? "Device operates normally"}`);
    if (taskInfo?.concerns?.length) goalLines.push(`**Concerns**: ${taskInfo.concerns.join(", ")}`);
    sections.push(h("Goal", ...goalLines));

    // --- Safety Constraints ---
    const constraints = taskInfo?.constraints;
    if (constraints && Object.keys(constraints).length > 0) {
      const cl: string[] = [];
      if (constraints.max_duration_sec != null) cl.push(`- max_duration_sec: ${constraints.max_duration_sec}s`);
      if (constraints.allow_flash != null) cl.push(`- allow_flash: ${constraints.allow_flash}`);
      if (constraints.allow_shell_exec != null) cl.push(`- allow_shell_exec: ${constraints.allow_shell_exec}`);
      if (constraints.no_flash) cl.push(`- no_flash: true`);
      if (cl.length > 0) sections.push(h("Safety Constraints", ...cl));
    }

    // --- Test Hint ---
    const hint = taskInfo?.test_hint as Record<string, unknown> | undefined;
    if (hint?.command) {
      const hl: string[] = [];
      if (hint.kind) hl.push(`**Kind**: ${hint.kind}`);
      if (hint.command) hl.push(`**Command**: ${hint.command}`);
      if (hint.pattern) hl.push(`**Pattern**: ${hint.pattern}`);
      hl.push("Create a dedicated step for this.");
      sections.push(h("Test Hint", ...hl));
    }

    // --- Target ---
    const tl: string[] = [];
    tl.push(`**ID**: ${run.target_id}`);
    tl.push(`**Artifact**: ${run.artifact.path} (${run.artifact.type}${run.artifact.version ? ` v${run.artifact.version}` : ""})`);
    const conns = target?.connections;
    if (conns && Object.keys(conns).length > 0) {
      tl.push(`**Connections**: ${Object.entries(conns).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
    sections.push(h("Target", ...tl));

    // --- Few-Shot Examples (perturbed) ---
    if (tier2.length > 0) {
      const sl: string[] = [];
      sl.push(`⚠ Examples below are randomly sampled from ${skillCandidates.length} relevant patterns — each plan generation may see different examples.`);
      sl.push("");
      for (let idx = 0; idx < tier2.length; idx++) {
        const s = tier2[idx]!;
        sl.push(`**Example: ${s.name}** — ${s.description}`);
        sl.push("```");
        sl.push(s.steps.map((st, i) => `${i + 1}. ${st.action} via ${st.capability}${st.command ? `: ${st.command}` : ""} [${st.timeout_sec}s]`).join("\n"));
        sl.push("```");
        sl.push(`Evidence: always=[${s.evidence.always.join(",")}] on_failure=[${s.evidence.on_failure.join(",")}]`);
        sl.push("");
        // Inject perturbation reminder after 2-3 examples
        if (idx === 1 && tier2.length > 2) {
          sl.push("⚠ These are REFERENCE patterns. Your specific device and task may require a different approach.");
          sl.push("");
        }
      }
      sections.push(h("Few-Shot Examples", ...sl));
    }

    // --- History (reference, not directive) ---
    const hl2: string[] = [];
    if (episodes.length > 0) {
      hl2.push("Recent episodes:");
      hl2.push(episodes.map(e => `- [${e.result}] ${e.episode_id}: ${e.summary}`).join("\n"));
    }
    const pitfalls = [...new Set(episodes.flatMap(e => e.pitfalls))];
    if (pitfalls.length > 0) {
      hl2.push("");
      hl2.push("Pitfalls to avoid:");
      hl2.push(bullets(pitfalls));
    }
    if (facts.length > 0) {
      hl2.push("");
      hl2.push("Known facts about this target:");
      hl2.push(facts.map(f => `- [${f.category}] ${f.statement}${f.verified ? " ✓" : ""}`).join("\n"));
    }
    if (hl2.length > 0) sections.push(h("History", ...hl2));

    return { staticPrompt: this.plannerPrompt, formattedContext: sections.join("\n") };
  }

  // ============================================================
  // Observer context — cache-aware 4-layer structure
  //
  // [BP1 — Deployment-level]  System Prompt (cacheable across all runs)
  // [BP2 — Run-level]         Goal + Known Issues + Evidence Policy
  // [BP3 — Semi-stable]       Working Memory + Recent Decisions + Checkpoint trends
  // [Uncached]                Constraints → Trigger → Evidence → Signals (recency-ordered)
  //
  // Constraints appears FIRST in the uncached section so it bounds
  // the decision before the LLM reads the triggering event details.
  // Evidence appears LAST for recency bias toward ground truth.
  // ============================================================

  async assembleObserverContext(
    runId: string,
    triggeringEvent: EventRecord,
    circuitBreakerActive = false,
    warningEscalation = false,
  ): Promise<ObserverContext> {
    const run = await this.runStore.get(runId);
    const targetId = run?.target_id ?? "";

    const [
      recentEvents,
      wm,
      facts,
      ts,
      startEvents,
    ] = await Promise.all([
      this.eventStore.read(runId, Math.max(0, triggeringEvent.seq - 200), 100),
      this.memory.readWorkingMemory(runId),
      this.memory.queryFacts("target", targetId, "known_issue", true),
      targetId ? (this.targetStore.getState?.(targetId) ?? Promise.resolve(null)) : Promise.resolve(null),
      this.eventStore.read(runId, 0, 1),
    ]);

    const sections: string[] = [];

    // ========================
    // [BP2 — Run-level invariant]
    // These sections are IDENTICAL across all Observer calls within a run.
    // ========================

    // --- Run Goal ---
    const runStart = startEvents.find(e => e.type === "run_started");
    const runPayload = (runStart?.payload ?? {}) as Record<string, unknown>;
    const goalLines: string[] = [];
    const task = (runPayload.task as string) ?? `Validate ${run?.artifact?.type ?? "device"}`;
    const expected = (runPayload.expected as string) ?? "Device operates normally";
    goalLines.push(`**Task**: ${task}`);
    goalLines.push(`**Expected**: ${expected}`);
    const planId = (runPayload.plan_id as string);
    if (planId) goalLines.push(`**Plan**: ${planId}`);
    const totalSteps = ((runPayload.steps as unknown[])?.length);
    if (totalSteps != null) goalLines.push(`**Total steps**: ${totalSteps}`);
    sections.push(h("Run Goal", ...goalLines));

    // --- Known Issues ---
    if (facts.length > 0) {
      const lines = facts.map(f => {
        let l = `- ${f.statement}`;
        if (f.extended_pattern) l += ` (pattern: \`${f.extended_pattern}\`)`;
        return l;
      });
      lines.push("");
      lines.push("When the triggering event matches a known issue semantically, consider whether this instance differs from past occurrences.");
      sections.push(h("Known Issues", ...lines));
    } else {
      sections.push(h("Known Issues", "(none recorded for this target)"));
    }

    // --- Evidence Policy ---
    const ep = (runPayload.evidence_policy as { always: string[]; on_failure: string[] } | undefined);
    if (ep) {
      sections.push(h("Evidence Policy",
        `Always collect: ${ep.always?.join(", ") ?? "none"}`,
        `On failure collect: ${ep.on_failure?.join(", ") ?? "none"}`,
      ));
    }

    // --- Success & Failure Criteria (for reference) ---
    const sc = runPayload.success_criteria as string[] | undefined;
    const fs = runPayload.failure_signals as string[] | undefined;
    if (sc?.length || fs?.length) {
      const cl: string[] = [];
      if (sc?.length) { cl.push("Success criteria:"); cl.push(...sc.map(c => `- ${c}`)); }
      if (fs?.length) { cl.push(""); cl.push("Failure signals:"); cl.push(...fs.map(s => `- ${s}`)); }
      sections.push(h("Criteria Reference", ...cl));
    }

    // ========================
    // [BP3 — Semi-stable]
    // Grows slowly over a run. Mostly stable between consecutive calls.
    // ========================

    // --- Working Memory ---
    if (wm.length > 0) {
      sections.push(h("Working Memory",
        ...wm.map(w => `- [${w.source}] ${w.key}: ${w.summary}`),
      ));
    }

    // --- Recent Decisions (last 10) ---
    const decEvents = recentEvents.filter(e => e.type === "decision_made");
    if (decEvents.length > 0) {
      const lines: string[] = [];
      for (const d of decEvents.slice(-10).reverse()) {
        const p = d.payload as Record<string, unknown> | undefined;
        const dec = (p?.decision as string) ?? "?";
        const conf = typeof p?.confidence === "number" ? ` conf=${p.confidence.toFixed(1)}` : "";
        lines.push(`- seq=${d.seq}: **${dec}**${conf} — ${d.summary}`);
      }
      sections.push(h("Recent Decisions", ...lines));
    }

    // --- Checkpoint History ---
    const cps = recentEvents.filter(e => e.type === "checkpoint");
    if (cps.length > 0) {
      const lines: string[] = [];
      for (const c of cps.slice(-5)) {
        const p = c.payload as Record<string, unknown> | undefined;
        const stage = (p?.stage as string) ?? "?";
        const lps = (p?.lines_per_sec as number);
        const samples = (p?.window_samples as number[]);
        if (samples?.length) {
          lines.push(`- seq=${c.seq}: stage=${stage}, samples=[${samples.join(",")}]`);
        } else {
          lines.push(`- seq=${c.seq}: stage=${stage}${lps != null ? `, ${lps} l/s` : ""}`);
        }
      }
      sections.push(h("Checkpoint History", ...lines));
    }

    // ========================
    // [Uncached — Variable]
    // Constraints FIRST so the decision boundary is read before the trigger.
    // Evidence LAST for recency bias toward ground truth.
    // ========================

    // --- Run State + Time ---
    const elapsed = run?.elapsed_sec ?? 0;
    const maxDur = (runPayload.estimated_duration_sec as number) ?? 600;
    const remaining = Math.max(0, maxDur - elapsed);
    sections.push(h("Run State",
      `State: ${run?.state ?? "?"}  Step: ${run?.current_step_id ?? "none"}`,
      `[t=${elapsed}s, remaining=${remaining}s, max=${maxDur}s]`,
    ));

    // --- Constraints (decision boundary) ---
    const caps = ts
      ? Object.keys(ts).filter(k => k !== "state" && ((ts as Record<string, unknown>)[k] === "connected" || (ts as Record<string, unknown>)[k] === "online"))
      : [];
    sections.push(h("Constraints",
      `Capabilities: ${caps.length > 0 ? caps.join(", ") : "unknown"}`,
      `CB1 (override breaker): ${circuitBreakerActive ? "ACTIVE — the system will downgrade 'stop' to 'suggest'" : "inactive"}`,
      `CB3 (warning escalation): ${warningEscalation ? "ACTIVE — the system applies conservative constraints" : "inactive"}`,
    ));

    // --- Target State ---
    if (ts) {
      sections.push(h("Target State",
        `Serial: ${ts.serial}  ADB: ${ts.adb}  Device: ${ts.state}`,
      ));
    }

    // --- Triggering Event ---
    const trLines: string[] = [];
    trLines.push(`Type: ${triggeringEvent.type}  Severity: **${triggeringEvent.severity ?? "info"}**`);
    trLines.push(`Summary: ${triggeringEvent.summary}`);
    if (triggeringEvent.step_id) trLines.push(`Step: ${triggeringEvent.step_id}`);
    if (triggeringEvent.evidence_refs?.length) {
      trLines.push(`Evidence refs: ${triggeringEvent.evidence_refs.join(", ")}`);
    }
    sections.push(h("Triggering Event", ...trLines));

    // --- Evidence Windows (recency position — LAST in uncached) ---
    const evRefs = triggeringEvent.evidence_refs ?? [];
    if (evRefs.length > 0 && this.evidence) {
      const lines: string[] = [];
      // Sample all available refs, not just 3. Max 5 to keep context manageable.
      for (let i = 0; i < Math.min(evRefs.length, 5); i++) {
        const content = await readEvidenceWindow(this.evidence, runId, evRefs[i]!, 8000);
        if (content) {
          lines.push(`**${evRefs[i]}**:`);
          lines.push("```");
          lines.push(content);
          lines.push("```");
          lines.push("");
        }
      }
      sections.push(h("Evidence Windows", ...lines));
    } else if (evRefs.length > 0) {
      sections.push(h("Evidence Windows", `${evRefs.length} window(s) available: ${evRefs.join(", ")}`));
    }

    // --- Recent Signals (all warning+ events, grouped by step) ---
    const sigs = recentEvents.filter(e => e.severity === "warning" || e.severity === "fatal");
    if (sigs.length > 0) {
      const currentStep = triggeringEvent.step_id;
      const byStep = new Map<string | undefined, typeof sigs>();
      for (const s of sigs) {
        const k = s.step_id as string | undefined;
        const g = byStep.get(k) ?? [];
        g.push(s);
        byStep.set(k, g);
      }

      const lines: string[] = [];
      lines.push(`${sigs.length} signal(s) across ${byStep.size} step(s).`);
      if (currentStep && byStep.has(currentStep)) {
        const cur = byStep.get(currentStep)!;
        byStep.delete(currentStep);
        lines.push("");
        lines.push(`Current step (${currentStep}) — ${cur.length} signal(s):`);
        lines.push(cur.map(e => `- [${e.severity ?? "?"}] ${e.type}: ${e.summary}`).join("\n"));
      }
      for (const [sid, evts] of byStep) {
        const fc = evts.filter(e => e.severity === "fatal").length;
        const wc = evts.filter(e => e.severity === "warning").length;
        lines.push(`- Step ${sid ?? "?"}: ${fc > 0 ? `${fc} fatal, ` : ""}${wc} warning — latest: ${evts[evts.length - 1]!.summary}`);
      }
      sections.push(h("Recent Signals", ...lines));
    }

    // --- Output Rhythm (raw time-series from Aggregator, no human labels) ---
    const lastCp = cps[cps.length - 1];
    if (lastCp) {
      const p = lastCp.payload as Record<string, unknown> | undefined;
      const samples = p?.window_samples as number[] | undefined;
      const transitions = p?.stage_transitions as { from: string; to: string; at_sec: number }[] | undefined;
      const crossSource = p?.cross_source_events as { source: string; exit: number; at_sec: number }[] | undefined;

      if (samples?.length || transitions?.length || crossSource?.length) {
        const rl: string[] = [];
        if (samples?.length) {
          rl.push(`Output samples (lines per window): [${samples.join(", ")}]`);
        }
        if (transitions?.length) {
          rl.push(`Stage transitions: ${transitions.map(t => `${t.from}→${t.to}@${t.at_sec}s`).join(", ")}`);
        }
        if (crossSource?.length) {
          rl.push(`Cross-source completions: ${crossSource.map(c => `${c.source}(exit=${c.exit})@${c.at_sec}s`).join(", ")}`);
        }
        sections.push(h("Output Rhythm", ...rl));
      }
    }

    return {
      staticPrompt: this.observerPrompt,
      formattedContext: sections.join("\n"),
      knownIssues: facts.length > 0 ? facts : undefined,
    };
  }
}
