import fs from "node:fs/promises";

type ArtifactView = { path: string; type: string; version?: string; build_id?: string };
type EventPayload = Record<string, unknown>;
type RunEventRecord = {
  seq: number; type: string; severity?: string; summary: string; step_id?: string;
  payload: EventPayload; evidence_refs?: string[]; time: string;
};
type KeyEvidenceView = { summary: string; evidence_refs: string[] };
type CriterionResultView = { criterion: string; status: string; evidence_refs: string[] };
type EvidenceIndexRefView = { ref: string; kind: string; bytes?: number; available: boolean };
type RelatedHistoryView = {
  episode_id: string; run_id: string; result: string; summary: string;
  recorded_at?: string; artifact_ref?: string; task?: string;
  state?: string; elapsed_sec?: number; created_at?: string; started_at?: string; ended_at?: string;
};
type ProcessSummaryItemView = {
  kind: "plan" | "device" | "evidence" | "warning" | "llm" | "result";
  status: "ok" | "warn" | "error" | "info";
  title: string;
  detail: string;
  seq?: number;
  step_id?: string;
  evidence_refs?: string[];
};
type RunStepView = {
  id: string; status: "pending" | "running" | "completed" | "failed";
  capability?: string; action?: string; command?: string; timeout_sec?: number;
  started_at?: string; ended_at?: string; exit_code?: number; evidence_refs: string[];
};

export type RunResultView = {
  run_id: string; state: string; result_available: boolean;
  summary?: string; suggested_next?: string; evidence_path?: string;
  key_evidence?: KeyEvidenceView[];
  criteria_results?: CriterionResultView[];
  target_id?: string; target_state?: string;
  artifact?: ArtifactView;
  source?: { kind: "manual" | "task"; task_name?: string; task?: string };
  timing?: { created_at: string; started_at?: string; ended_at?: string; elapsed_sec: number };
  task?: string; expected?: string; plan_id?: string; confidence?: number; failure_signature?: string;
  steps?: RunStepView[];
  evidence_index?: EvidenceIndexRefView[];
  missing_evidence_refs?: string[];
  event_summary?: { total: number; warnings: number; fatals: number; interventions: number; llm_calls: number };
  process_summary?: ProcessSummaryItemView[];
  related_history?: RelatedHistoryView[];
};

interface RunStoreReader {
  get(runId: string): Promise<{ run_id: string; state: string; target_id: string; current_step_id?: string; elapsed_sec: number; last_event_seq: number; evidence_root: string; artifact: { path: string; type: string; version?: string; build_id?: string }; failure_reason?: string; created_at: string; started_at?: string; ended_at?: string } | null>;
  listNonTerminal(): Promise<{ run_id: string; state: string; target_id: string }[]>;
}

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<RunEventRecord[]>;
}

interface EvidenceStoreReader {
  read(runId: string, ref: string): Promise<{ filePath: string; size: number; available: boolean }>;
  getIndex(runId: string): Promise<{ refs: { ref: string; kind: string; bytes?: number; available: boolean }[]; key_events: { seq: number; summary: string; evidence_refs: string[] }[] }>;
}

interface TargetStoreReader {
  getState(targetId: string): Promise<{ state: string; serial: string; adb: string; fastboot: string; current_run_id?: string; last_heartbeat_at?: string } | null>;
  listAll(): Promise<{ target_id: string }[]>;
  listStates(): Promise<{ target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string }[]>;
}

interface MemoryStoreReader {
  listByTarget(targetId: string, limit?: number): Promise<RelatedHistoryView[]>;
}

export class Views {
  constructor(
    private runStore: RunStoreReader,
    private eventStore: EventStoreReader,
    private evidenceStore: EvidenceStoreReader,
    private targetStore: TargetStoreReader,
    private memoryStore: MemoryStoreReader,
  ) {}

  async status(runId: string): Promise<{
    run_id: string; state: string; current_step?: { id: string }; target_state?: string;
    elapsed_sec: number; last_event_seq: number; evidence_path: string;
    created_at?: string; started_at?: string; ended_at?: string;
  } | null> {
    const run = await this.runStore.get(runId);
    if (!run) return null;
    const ts = await this.targetStore.getState(run.target_id);
    const result = {
      run_id: run.run_id, state: run.state, elapsed_sec: elapsedSecForRun(run),
      last_event_seq: run.last_event_seq, evidence_path: run.evidence_root,
    } as { run_id: string; state: string; current_step?: { id: string }; target_state?: string;
      elapsed_sec: number; last_event_seq: number; evidence_path: string; created_at?: string; started_at?: string; ended_at?: string; };
    if (run.current_step_id) result.current_step = { id: run.current_step_id };
    if (ts?.state) result.target_state = ts.state;
    if (run.created_at) result.created_at = run.created_at;
    if (run.started_at) result.started_at = run.started_at;
    if (run.ended_at) result.ended_at = run.ended_at;
    return result;
  }

  async events(runId: string, afterSeq = 0, limit = 100, types?: string[]): Promise<{
    events: { seq: number; type: string; severity?: string; summary: string; time: string }[];
    next_after_seq: number; has_more: boolean;
  }> {
    // Read extra events to compensate for type filtering — avoid empty pages
    const readLimit = types ? Math.max(limit * 3, 500) : limit + 1;
    const events = await this.eventStore.read(runId, afterSeq, readLimit);
    const filtered = types ? events.filter(e => types.includes(e.type)) : events;
    const ranOut = events.length < readLimit; // true if no more events in store
    const hasMore = ranOut ? filtered.length > limit : true; // more may exist beyond read window
    const sliced = filtered.slice(0, limit);
    return {
      events: sliced.map(e => {
        const item = { seq: e.seq, type: e.type, summary: e.summary, time: e.time } as { seq: number; type: string; severity?: string; summary: string; time: string; step_id?: string; payload?: Record<string, unknown>; evidence_refs?: string[] };
        if (e.severity) item.severity = e.severity;
        if (e.step_id) item.step_id = e.step_id;
        if (e.payload) item.payload = e.payload;
        if (e.evidence_refs) item.evidence_refs = e.evidence_refs;
        return item;
      }),
      next_after_seq: sliced.length > 0 ? sliced[sliced.length - 1]!.seq : afterSeq,
      has_more: hasMore,
    };
  }

  async result(runId: string): Promise<RunResultView> {
    const run = await this.runStore.get(runId);
    if (!run) return { run_id: runId, state: "unknown", result_available: false };
    const terminal = ["completed", "failed", "cancelled"].includes(run.state);
    const [targetState, events, evidenceRefs, relatedHistory] = await Promise.all([
      this.targetStore.getState(run.target_id).catch(() => null),
      this.readAllEvents(runId),
      this.readEvidenceIndex(runId),
      this.memoryStore.listByTarget(run.target_id, 6).catch(() => [] as RelatedHistoryView[]),
    ]);
    const resultReady = events.find(e => e.type === "result_ready");
    const runStarted = events.find(e => e.type === "run_started");
    const runPayload = runStarted?.payload ?? {};
    const source = sourceFromPayload(runPayload);
    const task = stringValue(runPayload["task"]);
    const expected = stringValue(runPayload["expected"]);
    const planId = stringValue(runPayload["plan_id"]);
    const steps = deriveSteps(events, evidenceRefs);
    const eventSummary = summarizeEvents(events);
    const processSummary = summarizeProcess(events, steps, evidenceRefs);

    const base = {
      run_id: runId,
      state: run.state,
      result_available: terminal,
      target_id: run.target_id,
      artifact: artifactView(run.artifact),
      source,
      timing: timingView(run),
      steps,
      evidence_index: evidenceRefs,
      event_summary: eventSummary,
      process_summary: processSummary,
      related_history: relatedHistory.filter(h => h.run_id !== runId),
    } as RunResultView;
    if (targetState?.state) base.target_state = targetState.state;
    if (task) base.task = task;
    if (expected) base.expected = expected;
    if (planId) base.plan_id = planId;

    if (!terminal) return base;

    if (resultReady) {
      const p = resultReady.payload;
      const result = { ...base, summary: stringValue(p["summary"]) ?? resultReady.summary };
      const suggestedNext = stringValue(p["suggested_next"]);
      const evidencePath = stringValue(p["evidence_path"]);
      const confidence = numberValue(p["confidence"]);
      const keyEvidence = keyEvidenceValue(p["key_evidence"]);
      const criteriaResults = criteriaResultsValue(p["criteria_results"]);
      const failureSignature = failureSignatureFrom(events, criteriaResults, run.failure_reason);
      if (suggestedNext) result.suggested_next = suggestedNext;
      if (evidencePath) result.evidence_path = evidencePath;
      if (confidence !== undefined) result.confidence = confidence;
      if (keyEvidence.length > 0) result.key_evidence = keyEvidence;
      if (criteriaResults.length > 0) result.criteria_results = criteriaResults;
      if (failureSignature) result.failure_signature = failureSignature;
      const missingRefs = missingEvidenceRefs(evidenceRefs, keyEvidence, criteriaResults, steps);
      if (missingRefs.length > 0) result.missing_evidence_refs = missingRefs;
      return result;
    }

    // Fallback: no result_ready event found
    const result: RunResultView = {
      ...base,
      summary: run.failure_reason ?? `Run ${run.state}`,
      suggested_next: "review evidence",
      evidence_path: run.evidence_root,
    };
    const failureSignature = failureSignatureFrom(events, [], run.failure_reason);
    if (failureSignature) result.failure_signature = failureSignature;
    return result;
  }

  async evidence(runId: string, ref?: string): Promise<{
    index?: { refs: { ref: string; kind: string; bytes?: number }[]; key_events: { seq: number; summary: string }[] };
    content?: string; filePath?: string; size?: number;
    available: boolean;
  }> {
    if (ref) {
      const ev = await this.evidenceStore.read(runId, ref);
      if (!ev.available) return { available: false };
      // Read evidence content for the ref
      try {
        // Read first 100KB only — avoid loading huge evidence files into memory
        const fh = await fs.open(ev.filePath, "r");
        const buf = Buffer.alloc(100_000);
        const { bytesRead } = await fh.read(buf, 0, 100_000, 0);
        await fh.close();
        return { content: buf.toString("utf-8", 0, bytesRead), filePath: ev.filePath, size: ev.size, available: true };
      } catch {
        return { filePath: ev.filePath, size: ev.size, available: true };
      }
    }
    const idx = await this.evidenceStore.getIndex(runId);
    return {
      index: {
        refs: idx.refs.map(r => {
          const item = { ref: r.ref, kind: r.kind } as { ref: string; kind: string; bytes?: number };
          if (r.bytes !== undefined) item.bytes = r.bytes;
          return item;
        }),
        key_events: idx.key_events.map(k => ({ seq: k.seq, summary: k.summary })),
      },
      available: true,
    };
  }

  async targets(): Promise<{ target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string }[]> {
    const [profiles, states] = await Promise.all([
      this.targetStore.listAll(),
      this.targetStore.listStates(),
    ]);
    const stateMap = new Map(states.map(s => [s.target_id, s]));
    return profiles.map(p => {
      const s = stateMap.get(p.target_id);
      const item = {
        target_id: p.target_id, state: s?.state ?? "unknown",
        serial: s?.serial ?? "unknown", adb: s?.adb ?? "unknown", fastboot: s?.fastboot ?? "unknown",
      } as { target_id: string; state: string; serial: string; adb: string; fastboot: string; current_run_id?: string };
      if (s?.current_run_id) item.current_run_id = s.current_run_id;
      return item;
    });
  }

  async history(targetId: string, limit = 10): Promise<RelatedHistoryView[]> {
    const episodes = await this.memoryStore.listByTarget(targetId, limit);
    return Promise.all(episodes.map(async episode => {
      const run = await this.runStore.get(episode.run_id).catch(() => null);
      if (!run) return episode;
      const enriched: RelatedHistoryView = {
        ...episode,
        state: run.state,
        elapsed_sec: elapsedSecForRun(run),
        created_at: run.created_at,
        artifact_ref: episode.artifact_ref || run.artifact.path,
      };
      if (run.started_at) enriched.started_at = run.started_at;
      if (run.ended_at) enriched.ended_at = run.ended_at;
      return enriched;
    }));
  }

  /** Rebuild all read projections — used during startup recovery. */
  async rebuild(): Promise<void> {
    // Preload target states and non-terminal runs to warm caches
    await Promise.all([this.targets(), this.runStore.listNonTerminal()]);
  }

  private async readAllEvents(runId: string, maxEvents = 5000): Promise<RunEventRecord[]> {
    const events: RunEventRecord[] = [];
    let afterSeq = 0;
    while (events.length < maxEvents) {
      const batch = await this.eventStore.read(runId, afterSeq, 500);
      if (batch.length === 0) break;
      events.push(...batch);
      const lastSeq = batch[batch.length - 1]!.seq;
      if (lastSeq <= afterSeq || batch.length < 500) break;
      afterSeq = lastSeq;
    }
    return events.slice(0, maxEvents);
  }

  private async readEvidenceIndex(runId: string): Promise<EvidenceIndexRefView[]> {
    try {
      const idx = await this.evidenceStore.getIndex(runId);
      return idx.refs.map(r => {
        const item: EvidenceIndexRefView = { ref: r.ref, kind: r.kind, available: r.available };
        if (r.bytes !== undefined) item.bytes = r.bytes;
        return item;
      });
    } catch {
      return [];
    }
  }
}

function artifactView(artifact: ArtifactView): ArtifactView {
  const view: ArtifactView = { path: artifact.path, type: artifact.type };
  if (artifact.version) view.version = artifact.version;
  if (artifact.build_id) view.build_id = artifact.build_id;
  return view;
}

function timingView(run: { state?: string; created_at: string; started_at?: string; ended_at?: string; elapsed_sec: number }): RunResultView["timing"] {
  const timing = { created_at: run.created_at, elapsed_sec: elapsedSecForRun(run) } as NonNullable<RunResultView["timing"]>;
  if (run.started_at) timing.started_at = run.started_at;
  if (run.ended_at) timing.ended_at = run.ended_at;
  return timing;
}

function elapsedSecForRun(run: { state?: string; elapsed_sec: number; created_at?: string; started_at?: string; ended_at?: string }): number {
  const stored = Math.max(0, Math.floor(run.elapsed_sec));
  const startedAt = timeMs(run.started_at) ?? timeMs(run.created_at);
  if (startedAt === null) return stored;

  const endedAt = timeMs(run.ended_at);
  if (endedAt !== null) return Math.max(0, Math.floor((endedAt - startedAt) / 1000));

  if (run.state && ["completed", "failed", "cancelled"].includes(run.state)) return stored;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function timeMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function sourceFromPayload(payload: EventPayload): NonNullable<RunResultView["source"]> {
  const source = payload["source"];
  if (isRecord(source) && source["kind"] === "task") {
    const result: NonNullable<RunResultView["source"]> = { kind: "task" };
    const taskName = stringValue(source["task_name"]);
    const task = stringValue(source["task"]);
    if (taskName) result.task_name = taskName;
    if (task) result.task = task;
    return result;
  }
  const sourceKind = payload["source_kind"];
  if (sourceKind === "task") {
    const result: NonNullable<RunResultView["source"]> = { kind: "task" };
    const taskName = stringValue(payload["task_name"]);
    if (taskName) result.task_name = taskName;
    return result;
  }
  return { kind: "manual" };
}

function deriveSteps(events: RunEventRecord[], evidenceIndex: EvidenceIndexRefView[]): RunStepView[] {
  const stepMap = new Map<string, RunStepView>();
  for (const step of plannerSteps(events)) stepMap.set(step.id, step);
  const evidenceSet = new Set(evidenceIndex.map(e => e.ref));

  for (const event of events) {
    const stepId = event.step_id ?? stringValue(event.payload["step_id"]);
    if (!stepId) continue;
    const current = stepMap.get(stepId) ?? { id: stepId, status: "pending", evidence_refs: [] };
    const next = { ...current, evidence_refs: [...current.evidence_refs] };
    addRefs(next.evidence_refs, event.evidence_refs ?? []);

    if (event.type === "step_started") {
      next.status = "running";
      next.started_at = next.started_at ?? event.time;
      const capability = stringValue(event.payload["capability"]);
      const action = stringValue(event.payload["action"]);
      if (capability) next.capability = capability;
      if (action) next.action = action;
    } else if (event.type === "observation") {
      const exitCode = numberValue(event.payload["exit_code"]);
      if (exitCode !== undefined) next.exit_code = exitCode;
    } else if (event.type === "step_completed") {
      next.status = "completed";
      next.ended_at = event.time;
    } else if (event.type === "step_failed") {
      next.status = "failed";
      next.ended_at = event.time;
    }

    const stepFullRef = `step-${stepId}:full`;
    if (evidenceSet.has(stepFullRef)) addRefs(next.evidence_refs, [stepFullRef]);
    stepMap.set(stepId, next);
  }

  return [...stepMap.values()].map(step => ({ ...step, evidence_refs: unique(step.evidence_refs) }));
}

function plannerSteps(events: RunEventRecord[]): RunStepView[] {
  for (const event of events) {
    if (event.type !== "llm_call" || event.payload["role"] !== "planner") continue;
    const raw = stringValue(event.payload["raw_content"]);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed["steps"])) continue;
      const steps: RunStepView[] = [];
      for (const item of parsed["steps"]) {
        if (!isRecord(item)) continue;
        const id = stringValue(item["id"]);
        if (!id) continue;
        const step: RunStepView = { id, status: "pending", evidence_refs: [] };
        const capability = stringValue(item["capability"]);
        const action = stringValue(item["action"]);
        const command = stringValue(item["command"]);
        const timeoutSec = numberValue(item["timeout_sec"]);
        if (capability) step.capability = capability;
        if (action) step.action = action;
        if (command) step.command = command;
        if (timeoutSec !== undefined) step.timeout_sec = timeoutSec;
        steps.push(step);
      }
      if (steps.length > 0) return steps;
    } catch { /* ignore malformed planner payload */ }
  }
  return [];
}

function summarizeEvents(events: RunEventRecord[]): NonNullable<RunResultView["event_summary"]> {
  return {
    total: events.length,
    warnings: events.filter(e => e.severity === "warning").length,
    fatals: events.filter(e => e.severity === "fatal").length,
    interventions: events.filter(e => e.type === "human_note" || e.type === "rule_ignored" || e.type === "override_applied").length,
    llm_calls: events.filter(e => e.type === "llm_call").length,
  };
}

function summarizeProcess(
  events: RunEventRecord[],
  steps: RunStepView[],
  evidenceRefs: EvidenceIndexRefView[],
): ProcessSummaryItemView[] {
  const items: ProcessSummaryItemView[] = [];
  const planGenerated = events.find(e => e.type === "plan_generated");
  if (planGenerated) {
    const stepCount = numberValue(planGenerated.payload["step_count"]);
    const estimate = numberValue(planGenerated.payload["estimated_duration_sec"]);
    const detail = [
      stepCount !== undefined ? `${stepCount} step${stepCount === 1 ? "" : "s"}` : undefined,
      estimate !== undefined ? `${estimate}s estimated` : undefined,
    ].filter(Boolean).join("; ");
    items.push({
      kind: "plan",
      status: "ok",
      title: "Execution plan ready",
      detail: detail || planGenerated.summary,
      seq: planGenerated.seq,
    });
  }

  for (const step of steps) {
    if (step.status !== "completed" && step.status !== "failed") continue;
    const status = step.status === "completed" ? "ok" : "error";
    const action = [step.capability, step.action].filter(Boolean).join(" / ");
    const detailParts = [
      action || undefined,
      step.started_at && step.ended_at ? durationText(step.started_at, step.ended_at) : undefined,
      step.evidence_refs.length > 0 ? `${step.evidence_refs.length} evidence ref${step.evidence_refs.length === 1 ? "" : "s"}` : undefined,
    ].filter(Boolean);
    items.push({
      kind: "device",
      status,
      title: step.status === "completed" ? "Device step completed" : "Device step failed",
      detail: detailParts.join("; ") || step.id,
      step_id: step.id,
      evidence_refs: step.evidence_refs,
    });
  }

  const observationLines = events
    .filter(e => e.type === "observation")
    .reduce((total, e) => total + (numberValue(e.payload["lines"]) ?? 0), 0);
  if (observationLines > 0 || evidenceRefs.length > 0) {
    const detail = [
      observationLines > 0 ? `${observationLines} lines processed` : undefined,
      `${evidenceRefs.length} log file${evidenceRefs.length === 1 ? "" : "s"} available`,
    ].filter(Boolean).join("; ");
    items.push({
      kind: "evidence",
      status: evidenceRefs.length > 0 ? "ok" : "warn",
      title: evidenceRefs.length > 0 ? "Log captured" : "Log events seen",
      detail,
      evidence_refs: evidenceRefs.map(ref => ref.ref),
    });
  }

  const warningEvents = events.filter(e => e.severity === "warning" || e.type === "rule_matched");
  for (const warning of warningEvents.slice(-3)) {
    const item: ProcessSummaryItemView = {
      kind: "warning",
      status: warning.severity === "fatal" ? "error" : "warn",
      title: warning.type === "rule_matched" ? "Rule matched" : "Runtime warning",
      detail: warning.summary,
      seq: warning.seq,
    };
    if (warning.step_id) item.step_id = warning.step_id;
    if (warning.evidence_refs) item.evidence_refs = warning.evidence_refs;
    items.push(item);
  }

  const llmFallbacks = events.filter(e => e.type === "llm_call" && e.payload["fallback"] === true);
  if (llmFallbacks.length > 0) {
    const roles = unique(llmFallbacks.map(e => stringValue(e.payload["role"]) ?? "llm"));
    const lastError = lastDefined(llmFallbacks.map(e => stringValue(e.payload["error"])));
    const item: ProcessSummaryItemView = {
      kind: "llm",
      status: "warn",
      title: "Result text used fallback",
      detail: lastError
        ? `${roles.join(", ")} unavailable: ${lastError}; device execution still used collected evidence`
        : `${roles.join(", ")} unavailable; device execution still used collected evidence`,
    };
    const lastSeq = llmFallbacks[llmFallbacks.length - 1]?.seq;
    if (lastSeq !== undefined) item.seq = lastSeq;
    items.push(item);
  }

  const resultReady = events.find(e => e.type === "result_ready");
  if (resultReady) {
    const status = stringValue(resultReady.payload["status"]);
    items.push({
      kind: "result",
      status: status === "failed" ? "error" : status === "cancelled" ? "warn" : "ok",
      title: "Result generated",
      detail: resultReady.summary,
      seq: resultReady.seq,
    });
  }

  return items;
}

function durationText(start: string, end: string): string | undefined {
  const started = new Date(start).getTime();
  const ended = new Date(end).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return `${Math.round((ended - started) / 1000)}s`;
}

function keyEvidenceValue(value: unknown): KeyEvidenceView[] {
  if (!Array.isArray(value)) return [];
  const items: KeyEvidenceView[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const summary = stringValue(raw["summary"]);
    if (!summary) continue;
    items.push({ summary, evidence_refs: stringArrayValue(raw["evidence_refs"]) });
  }
  return items;
}

function criteriaResultsValue(value: unknown): CriterionResultView[] {
  if (!Array.isArray(value)) return [];
  const items: CriterionResultView[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const criterion = stringValue(raw["criterion"]);
    const status = stringValue(raw["status"]);
    if (!criterion || !status) continue;
    items.push({ criterion, status, evidence_refs: stringArrayValue(raw["evidence_refs"]) });
  }
  return items;
}

function failureSignatureFrom(events: RunEventRecord[], criteria: CriterionResultView[], fallback?: string): string | undefined {
  const failedCriterion = criteria.find(c => c.status === "fail" || c.status === "unknown");
  if (failedCriterion) return `${failedCriterion.status}: ${failedCriterion.criterion}`;
  const fatal = [...events].reverse().find(e => e.severity === "fatal" || e.type === "step_failed");
  if (fatal) return fatal.summary;
  return fallback;
}

function missingEvidenceRefs(
  evidenceIndex: EvidenceIndexRefView[],
  keyEvidence: KeyEvidenceView[],
  criteria: CriterionResultView[],
  steps: RunStepView[],
): string[] {
  const known = new Set(evidenceIndex.map(e => e.ref));
  const refs = [
    ...keyEvidence.flatMap(e => e.evidence_refs),
    ...criteria.flatMap(c => c.evidence_refs),
    ...steps.flatMap(s => s.evidence_refs),
  ];
  return unique(refs).filter(ref => !known.has(ref));
}

function addRefs(target: string[], refs: string[]): void {
  for (const ref of refs) {
    if (ref && !target.includes(ref)) target.push(ref);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function lastDefined<T>(values: (T | undefined)[]): T | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
