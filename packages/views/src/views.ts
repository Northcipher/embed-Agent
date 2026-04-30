import fs from "node:fs/promises";

interface RunStoreReader {
  get(runId: string): Promise<{ run_id: string; state: string; target_id: string; current_step_id?: string; elapsed_sec: number; last_event_seq: number; evidence_root: string; artifact: { path: string; type: string; version?: string; build_id?: string }; failure_reason?: string; created_at: string; started_at?: string; ended_at?: string } | null>;
  listNonTerminal(): Promise<{ run_id: string; state: string; target_id: string }[]>;
}

interface EventStoreReader {
  read(runId: string, afterSeq?: number, limit?: number): Promise<{ seq: number; type: string; severity?: string; summary: string; step_id?: string; payload: Record<string, unknown>; evidence_refs?: string[]; time: string }[]>;
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
  listByTarget(targetId: string, limit?: number): Promise<{ episode_id: string; result: string; summary: string }[]>;
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
  } | null> {
    const run = await this.runStore.get(runId);
    if (!run) return null;
    const ts = await this.targetStore.getState(run.target_id);
    const result = {
      run_id: run.run_id, state: run.state, elapsed_sec: run.elapsed_sec,
      last_event_seq: run.last_event_seq, evidence_path: run.evidence_root,
    } as { run_id: string; state: string; current_step?: { id: string }; target_state?: string;
      elapsed_sec: number; last_event_seq: number; evidence_path: string; };
    if (run.current_step_id) result.current_step = { id: run.current_step_id };
    if (ts?.state) result.target_state = ts.state;
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
    const hasMore = filtered.length > limit;
    const sliced = filtered.slice(0, limit);
    return {
      events: sliced.map(e => {
        const item = { seq: e.seq, type: e.type, summary: e.summary, time: e.time } as { seq: number; type: string; severity?: string; summary: string; time: string };
        if (e.severity) item.severity = e.severity;
        return item;
      }),
      next_after_seq: sliced.length > 0 ? sliced[sliced.length - 1]!.seq : afterSeq,
      has_more: hasMore,
    };
  }

  async result(runId: string): Promise<{
    run_id: string; state: string; result_available: boolean;
    summary?: string; suggested_next?: string; evidence_path?: string;
    key_evidence?: { summary: string; evidence_refs: string[] }[];
  }> {
    const run = await this.runStore.get(runId);
    if (!run) return { run_id: runId, state: "unknown", result_available: false };
    const terminal = ["completed", "failed", "cancelled"].includes(run.state);
    if (!terminal) return { run_id: runId, state: run.state, result_available: false };

    // Look for result_ready event — the authoritative result.
    // Read from after the run started (seq 0) to catch result_ready wherever it lands.
    const events = await this.eventStore.read(runId, 0, 1000);
    const resultReady = events.find(e => e.type === "result_ready");
    if (resultReady) {
      const p = resultReady.payload as Record<string, unknown>;
      const result = {
        run_id: runId, state: run.state, result_available: true as const,
        summary: (p.summary as string) ?? (resultReady.summary as string),
      } as {
        run_id: string; state: string; result_available: boolean;
        summary?: string; suggested_next?: string; evidence_path?: string;
        key_evidence?: { summary: string; evidence_refs: string[] }[];
      };
      if (p.suggested_next) result.suggested_next = p.suggested_next as string;
      if (p.evidence_path) result.evidence_path = p.evidence_path as string;
      const ke = p.key_evidence as { summary: string; evidence_refs: string[] }[] | undefined;
      if (ke && ke.length > 0) result.key_evidence = ke;
      return result;
    }

    // Fallback: no result_ready event found
    const result = {
      run_id: runId, state: run.state, result_available: true as const,
      summary: run.failure_reason ?? `Run ${run.state}`,
      suggested_next: "review evidence" as string | undefined,
      evidence_path: run.evidence_root,
    } as {
      run_id: string; state: string; result_available: boolean;
      summary?: string; suggested_next?: string; evidence_path?: string;
      key_evidence?: { summary: string; evidence_refs: string[] }[];
    };
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
        const content = await fs.readFile(ev.filePath, "utf-8");
        return { content: content.slice(0, 100_000), filePath: ev.filePath, size: ev.size, available: true };
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

  async history(targetId: string, limit = 10): Promise<{ episode_id: string; result: string; summary: string }[]> {
    return this.memoryStore.listByTarget(targetId, limit);
  }

  /** Rebuild all read projections — used during startup recovery. */
  async rebuild(): Promise<void> {
    // Preload target states and non-terminal runs to warm caches
    await Promise.all([this.targets(), this.runStore.listNonTerminal()]);
  }
}
