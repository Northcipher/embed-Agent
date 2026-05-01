/**
 * ContextAssembler — builds LLM context per role, not per data source.
 *
 * Design principles:
 *   Planner  = generate (few-shot) → Goal first, ref at end.
 *   Observer = discriminate (recency) → stable prefix → cacheable. Constraints + trigger + evidence last: recency zone.
 *   Reply    = evaluate (primacy) → Criteria first, evidence last.
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
  knownIssues?: { fact_id: string; category: string; statement: string; extended_pattern?: string }[] | undefined;
}

// --- Inline fallback prompts (used when config/prompts/ not loaded) ---

const PLANNER_FALLBACK = `You are an Embed Agent Task Planner. Create a concrete, executable validation plan.

Given a target device with specific connections (serial, adb, ssh, local, fastboot) and a task, produce a step-by-step plan.

Capability × Action matrix (ONLY these combinations):
  local_exec   → exec   (host machine shell command)
  shell_exec   → exec   (device shell via ADB)
  ssh_exec     → exec   (device shell via SSH)
  serial_output → stream (serial console output)
  adb_logs     → stream (live logcat)  or  exec (logcat -d dump)
  wait_adb     → wait   (wait for ADB)
  flash        → flash  (fastboot flash, command="<image>:<partition>")
  push         → push   (file push, command="<src>:<dst>")
  collect_logs → exec   (dmesg/logcat)

Output JSON: { plan_id, estimated_duration_sec, steps: [{ id, capability, action, command?, timeout_sec }], evidence_policy: { always, on_failure }, success_criteria, failure_signals }`;

const OBSERVER_FALLBACK = `You are an Embed Agent Observer. Decide: continue, stop, collect_more, extend_wait, pause, or suggest.

Priority:
1. fatal severity → stop
2. known issue match → continue
3. warning → check evidence windows; confirm → stop/collect_more; ambiguous → continue
4. timeout/slow → extend_wait if device active, collect_more if silent
5. otherwise → continue

CB1 active → only suggest, never stop. CB3 escalation → more conservative.

Output JSON: { decision, reason, confidence, reasoning_trace, evidence_refs?, params?, suggestion? }`;

const REPLY_FALLBACK = `You are an Embed Agent Reply Generator. The run status (completed/failed/cancelled) is pre-determined by the system — you do NOT output it. Your job is to produce the narrative: summary, key_evidence, criteria_results, suggested_next, and confidence.

Output JSON: { summary, suggested_next, key_evidence: [{ summary, evidence_refs }], criteria_results: [{ criterion, status: "pass"|"fail"|"unknown", evidence_refs }], confidence }`;

// --- Helpers ---

function h(heading: string, ...lines: string[]): string {
  const body = lines.filter(l => l !== "").join("\n");
  return body.trim() ? `## ${heading}\n${body}\n` : "";
}

function bullets(items: string[]): string {
  return items.map(i => `- ${i}`).join("\n");
}

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
  // Planner: Goal → Constraints → Target → Skills → History
  //
  // LLM needs: what to do, what's allowed, what device has,
  //            patterns to follow, lessons from past.
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
    const tier1 = this.skillRegistry?.matchTop(taskDesc, 5) ?? [];
    const tier2 = this.skillRegistry?.loadMatchedSteps(taskDesc, 3) ?? [];

    const sections: string[] = [];

    // 1. Goal — primacy: what to do, what success looks like
    const goalLines: string[] = [];
    goalLines.push(`**Task**: ${taskInfo?.task ?? `Validate ${run.artifact.type} on ${run.target_id}`}`);
    goalLines.push(`**Expected**: ${taskInfo?.expected ?? "Device operates normally"}`);
    if (taskInfo?.concerns?.length) goalLines.push(`**Concerns**: ${taskInfo.concerns.join(", ")}`);
    sections.push(h("Goal", ...goalLines));

    // 2. Safety Constraints — boundaries for the plan
    const constraints = taskInfo?.constraints;
    if (constraints && Object.keys(constraints).length > 0) {
      const cl: string[] = [];
      if (constraints.max_duration_sec != null) cl.push(`- max_duration_sec: ${constraints.max_duration_sec}s`);
      if (constraints.allow_flash != null) cl.push(`- allow_flash: ${constraints.allow_flash}`);
      if (constraints.allow_shell_exec != null) cl.push(`- allow_shell_exec: ${constraints.allow_shell_exec}`);
      if (constraints.no_flash) cl.push(`- no_flash: true`);
      if (cl.length > 0) sections.push(h("Safety Constraints", ...cl));
    }

    // 3. Test Hint
    const hint = taskInfo?.test_hint as Record<string, unknown> | undefined;
    if (hint?.command) {
      const hl: string[] = [];
      if (hint.kind) hl.push(`**Kind**: ${hint.kind}`);
      if (hint.command) hl.push(`**Command**: ${hint.command}`);
      if (hint.pattern) hl.push(`**Pattern**: ${hint.pattern}`);
      hl.push("Create a dedicated step for this.");
      sections.push(h("Test Hint", ...hl));
    }

    // 4. Target — what connections are available → what capabilities can be used
    const tl: string[] = [];
    tl.push(`**ID**: ${run.target_id}`);
    tl.push(`**Artifact**: ${run.artifact.path} (${run.artifact.type}${run.artifact.version ? ` v${run.artifact.version}` : ""})`);
    const conns = target?.connections;
    if (conns && Object.keys(conns).length > 0) {
      tl.push(`**Connections**: ${Object.entries(conns).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
    sections.push(h("Target", ...tl));

    // 5. Few-Shot Examples — validated patterns (REFERENCE, not primary)
    if (tier2.length > 0) {
      const sl: string[] = [];
      sl.push("Validated plan patterns. Prefer these over inventing new step sequences.");
      sl.push("");
      for (const s of tier2) {
        sl.push(`**Example: ${s.name}** — ${s.description}`);
        sl.push("```");
        sl.push(s.steps.map((st, i) => `${i + 1}. ${st.action} via ${st.capability}${st.command ? `: ${st.command}` : ""} [${st.timeout_sec}s]`).join("\n"));
        sl.push("```");
        sl.push(`Evidence: always=[${s.evidence.always.join(",")}] on_failure=[${s.evidence.on_failure.join(",")}]`);
        sl.push("");
      }
      sections.push(h("Few-Shot Examples", ...sl));
    }

    // 6. History — what happened before (PAST, not directive)
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
  // Observer: Stable → Cumulative → Variable
  //
  // Stable (cached across calls): Known Issues, Evidence Policy
  // Cumulative (prefix stable):    Decisions, Checkpoints, WM
  // Variable (recency zone):       Run State → Constraints →
  //                                 Trigger → Evidence → Signals
  //
  // Constraints is in the variable section START so it's the
  // first thing LLM reads in the recency zone — directly
  // constraining the decision space.
  // ============================================================

  async assembleObserverContext(
    runId: string,
    triggeringEvent: EventRecord,
    circuitBreakerActive = false,
    warningEscalation = false,
  ): Promise<ObserverContext> {
    const run = await this.runStore.get(runId);
    const targetId = run?.target_id ?? "";

    const [recentEvents, wm, facts, ts, startEvents] = await Promise.all([
      this.eventStore.read(runId, Math.max(0, triggeringEvent.seq - 100), 50),
      this.memory.readWorkingMemory(runId),
      this.memory.queryFacts("target", targetId, "known_issue", true),
      targetId ? (this.targetStore.getState?.(targetId) ?? Promise.resolve(null)) : Promise.resolve(null),
      this.eventStore.read(runId, 0, 1),
    ]);

    const sections: string[] = [];

    // ========================
    // STABLE — cacheable across Observer calls within same run
    // ========================

    // Known Issues — verified patterns from past episodes
    if (facts.length > 0) {
      const lines = facts.map(f => {
        let l = `- ${f.statement}`;
        if (f.extended_pattern) l += ` (pattern: \`${f.extended_pattern}\`)`;
        return l;
      });
      sections.push(h("Known Issues", ...lines));
    }

    // Evidence Policy — what to collect on collect_more
    const runStart = startEvents.find(e => e.type === "run_started");
    const ep = (runStart?.payload as Record<string, unknown> | undefined)?.evidence_policy as { always: string[]; on_failure: string[] } | undefined;
    if (ep) {
      sections.push(h("Evidence Policy",
        `Always collect: ${ep.always?.join(", ") ?? "none"}`,
        `On failure collect: ${ep.on_failure?.join(", ") ?? "none"}`,
      ));
    }

    // ========================
    // CUMULATIVE — prefix mostly stable, grows slowly
    // ========================

    // Working Memory
    if (wm.length > 0) {
      sections.push(h("Working Memory",
        ...wm.map(w => `- [${w.source}] ${w.key}: ${w.summary}`),
      ));
    }

    // Recent Decisions
    const decEvents = recentEvents.filter(e => e.type === "decision_made");
    if (decEvents.length > 0) {
      const lines: string[] = [];
      for (const d of decEvents.slice(-5).reverse()) {
        const p = d.payload as Record<string, unknown> | undefined;
        const dec = (p?.decision as string) ?? "?";
        const conf = typeof p?.confidence === "number" ? ` conf=${p.confidence.toFixed(1)}` : "";
        lines.push(`- seq=${d.seq}: **${dec}**${conf} ${d.summary}`);
        if (p?.reasoning_trace) lines.push(`  > ${p.reasoning_trace as string}`);
      }
      const decisions = decEvents.slice(-5).map(e => (e.payload as Record<string, unknown>)?.decision as string).filter(Boolean);
      if (new Set(decisions).size === 1 && decisions.length >= 3) {
        lines.push(`  ⚠ Last ${decisions.length} decisions all "${decisions[0]}" — stuck loop?`);
      }
      sections.push(h("Recent Decisions", ...lines));
    }

    // Checkpoint History
    const cps = recentEvents.filter(e => e.type === "checkpoint");
    if (cps.length > 0) {
      const lines: string[] = [];
      for (const c of cps.slice(-5)) {
        const p = c.payload as Record<string, unknown> | undefined;
        lines.push(`- seq=${c.seq}: ${(p?.stage as string) ?? "?"} stage, ${(p?.lines_per_sec as number) ?? "?"} l/s, pattern=${(p?.output_pattern as string) ?? "?"}`);
      }
      const lpsVals = cps.slice(-5).map(e => (e.payload as Record<string, unknown>)?.lines_per_sec as number | undefined).filter((v): v is number => typeof v === "number");
      if (lpsVals.length >= 2) {
        const first = lpsVals[0]!, last = lpsVals[lpsVals.length - 1]!;
        const trend = last > first * 1.1 ? "improving" : last < first * 0.9 ? "degrading" : "stable";
        lines.push(`Trend: **${trend}**`);
      }
      sections.push(h("Checkpoint History", ...lines));
    }

    // ========================
    // VARIABLE — recency zone. Constraints FIRST so it constrains
    // the decision before LLM reads what happened.
    // ========================

    // Run State
    const rsLines: string[] = [];
    rsLines.push(`State: ${run?.state ?? "?"}  Elapsed: ${run?.elapsed_sec ?? 0}s`);
    if (run?.current_step_id) rsLines.push(`Step: ${run.current_step_id}`);
    sections.push(h("Run State", ...rsLines));

    // Constraints — decision boundary, recency position
    const maxDur = (runStart?.payload as Record<string, unknown> | undefined)?.estimated_duration_sec as number | undefined;
    const remaining = Math.max(0, (maxDur ?? 600) - (run?.elapsed_sec ?? 0));
    const caps = ts
      ? Object.keys(ts).filter(k => k !== "state" && ((ts as Record<string, unknown>)[k] === "connected" || (ts as Record<string, unknown>)[k] === "online"))
      : [];
    const clines: string[] = [];
    clines.push(`⚠ This section reflects the current observation only — values change every call.`);
    clines.push(`Remaining: **${remaining}s**`);
    clines.push(`Capabilities: ${caps.length > 0 ? caps.join(", ") : "unknown"}`);
    clines.push(`CB1 (override breaker): **${circuitBreakerActive ? "ACTIVE — only suggest" : "inactive"}**`);
    clines.push(`CB3 (warning escalation): **${warningEscalation ? "ACTIVE — be conservative" : "inactive"}**`);
    sections.push(h("Constraints", ...clines));

    // Target State
    if (ts) {
      sections.push(h("Target State",
        `Serial: ${ts.serial}  ADB: ${ts.adb}  Device: ${ts.state}`,
      ));
    }

    // Triggering Event
    const trLines: string[] = [];
    trLines.push(`Type: ${triggeringEvent.type}  Severity: **${triggeringEvent.severity ?? "info"}**`);
    trLines.push(`Summary: ${triggeringEvent.summary}`);
    if (triggeringEvent.step_id) trLines.push(`Step: ${triggeringEvent.step_id}`);
    if (triggeringEvent.evidence_refs?.length) trLines.push(`Evidence refs: ${triggeringEvent.evidence_refs.join(", ")}`);
    sections.push(h("Triggering Event", ...trLines));

    // Evidence Windows — ground truth
    const evRefs = triggeringEvent.evidence_refs ?? [];
    if (evRefs.length > 0 && this.evidence) {
      const lines: string[] = [];
      for (let i = 0; i < Math.min(evRefs.length, 3); i++) {
        const content = await this.evidence.readContent(runId, evRefs[i]!, 3000);
        if (content) {
          lines.push(`**${evRefs[i]}**:`);
          lines.push("```");
          lines.push(content.slice(-3000));
          lines.push("```");
          lines.push("");
        }
      }
      sections.push(h("Evidence Windows", ...lines));
    } else if (evRefs.length > 0) {
      sections.push(h("Evidence Windows", `${evRefs.length} window(s) available: ${evRefs.join(", ")}`));
    }

    // Recent Signals — by step phase
    const sigs = recentEvents.filter(e => e.severity === "warning" || e.severity === "fatal");
    if (sigs.length > 0) {
      const currentStep = triggeringEvent.step_id;
      const byStep = new Map<string | undefined, typeof sigs>();
      for (const s of sigs) { const k = s.step_id as string | undefined; const g = byStep.get(k) ?? []; g.push(s); byStep.set(k, g); }

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

    return {
      staticPrompt: this.observerPrompt,
      formattedContext: sections.join("\n"),
      knownIssues: facts.length > 0 ? facts : undefined,
    };
  }

}
