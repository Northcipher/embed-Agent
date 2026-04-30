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
    const events = await this.eventStore.read(runId, afterSeq, limit + 1);
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
    const events = await this.eventStore.read(runId, Math.max(0, run.last_event_seq - 20), 20);
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
    const keyEvidence = events.filter(e => e.evidence_refs?.length).map(e => ({
      summary: e.summary, evidence_refs: e.evidence_refs ?? [],
    }));
    if (keyEvidence.length > 0) result.key_evidence = keyEvidence;
    return result;
  }

  async evidence(runId: string, ref?: string): Promise<{
    index?: { refs: { ref: string; kind: string; bytes?: number }[]; key_events: { seq: number; summary: string }[] };
    content?: string; available: boolean;
  }> {
    if (ref) {
      const ev = await this.evidenceStore.read(runId, ref);
      return { available: ev.available };
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

  async targets(): Promise<{ target_id: string; state: string; current_run_id?: string }[]> {
    const runs = await this.runStore.listNonTerminal();
    const results = await Promise.all(runs.map(async r => {
      const ts = await this.targetStore.getState(r.target_id);
      const item = { target_id: r.target_id, state: ts?.state ?? "unknown" } as { target_id: string; state: string; current_run_id?: string };
      if (ts?.current_run_id) item.current_run_id = ts.current_run_id;
      return item;
    }));
    return results;
  }

  async history(targetId: string, limit = 10): Promise<{ episode_id: string; result: string; summary: string }[]> {
    return this.memoryStore.listByTarget(targetId, limit);
  }
}
