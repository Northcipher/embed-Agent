import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";
import { validateId } from "./validate.js";

// --- Types ---

export interface EvidenceRef {
  ref: string;
  kind: "log" | "window" | "snapshot";
  path: string;
  available: boolean;
  bytes?: number;
  important?: boolean;
}

export interface KeyEvent {
  seq: number;
  summary: string;
  evidence_refs: string[];
}

export interface EvidenceIndex {
  run_id: string;
  partial: boolean;
  updated_at: string;
  root_path: string;
  refs: EvidenceRef[];
  key_events: KeyEvent[];
}

// --- Validation ---

function validateRef(ref: string): void {
  if (ref.includes("..") || ref.includes("/") || ref.includes("\\")) {
    throw new Error(`Invalid evidence ref: "${ref}" contains path characters`);
  }
  if (ref.length === 0 || ref.length > 256) {
    throw new Error(`Invalid evidence ref: length must be 1-256, got ${ref.length}`);
  }
}

// --- Event emitter interface ---

interface Emitter {
  emit(e: Record<string, unknown>): void;
}

// --- Evidence Store ---

export interface RetentionConfig {
  success_days: number;
  failure_days: number;
  max_episodes_per_target: number;
}

const DEFAULT_RETENTION: RetentionConfig = {
  success_days: 30,
  failure_days: 90,
  max_episodes_per_target: 100,
};

export class EvidenceStore {
  private dataRoot: string;
  /** Per-run mutex for index read-modify-write serialization. */
  private indexLocks = new Map<string, Promise<void>>();
  private eb: Emitter | undefined;
  private retention: RetentionConfig;

  constructor(dataRoot = ".embed-agent", eb?: Emitter, retention?: Partial<RetentionConfig>) {
    this.dataRoot = path.resolve(dataRoot);
    this.eb = eb;
    this.retention = { ...DEFAULT_RETENTION, ...retention };
  }

  private runDir(runId: string): string {
    validateId(runId, "runId");
    return path.join(this.dataRoot, "runs", runId);
  }

  private indexPath(runId: string): string {
    return path.join(this.runDir(runId), "evidence-index.json");
  }

  /** Serialize index mutations per run to prevent lost updates under concurrency. */
  private serializedIndex(runId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.indexLocks.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.indexLocks.set(runId, next);
    return next;
  }

  // --- Write ---

  async write(runId: string, ref: string, data: string | Buffer): Promise<{ filePath: string; bytes: number }> {
    validateId(runId, "runId");
    validateRef(ref);

    const dir = this.runDir(runId);
    await fs.mkdir(path.join(dir, "snapshots"), { recursive: true });

    const fileName = this.refToFile(ref);
    const filePath = path.join(dir, fileName);
    const content = typeof data === "string" ? Buffer.from(data) : data;

    // Atomic write with unique temp name (same pattern as writeAtomic, handles Buffer)
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, filePath);

    const refObj: EvidenceRef = { ref, kind: this.refKind(ref), path: fileName, available: true, bytes: content.length };
    await this.addRef(runId, refObj);

    // Emit audit event
    this.eb?.emit({
      type: "evidence_collected",
      run_id: runId,
      source: "evidence_store",
      summary: `Evidence ${ref} written (${content.length} bytes)`,
      payload: { ref, bytes: content.length, kind: refObj.kind },
    });

    return { filePath, bytes: content.length };
  }

  // --- Read ---

  async read(runId: string, ref: string): Promise<{ filePath: string; size: number; available: boolean }> {
    validateId(runId, "runId");
    validateRef(ref);
    const filePath = path.join(this.runDir(runId), this.refToFile(ref));
    try {
      const stat = await fs.stat(filePath);
      return { filePath, size: stat.size, available: true };
    } catch {
      return { filePath, size: 0, available: false };
    }
  }

  /** Read evidence content with optional size cap. Returns tail of file when capped. */
  async readContent(runId: string, ref: string, maxBytes?: number): Promise<string | null> {
    validateId(runId, "runId");
    validateRef(ref);
    const filePath = path.join(this.runDir(runId), this.refToFile(ref));
    try {
      const stat = await fs.stat(filePath);
      if (maxBytes && stat.size > maxBytes) {
        // Read tail of large files — most recent output is most relevant
        const fd = await fs.open(filePath, "r");
        const buf = Buffer.alloc(maxBytes);
        await fd.read(buf, 0, maxBytes, stat.size - maxBytes);
        await fd.close();
        const text = buf.toString("utf-8");
        // Skip partial first line (likely truncated mid-line)
        const newlineIdx = text.indexOf("\n");
        return newlineIdx >= 0 ? `[...truncated ${stat.size - maxBytes} bytes...]\n${text.slice(newlineIdx + 1)}` : text;
      }
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  // --- Index ---

  async getIndex(runId: string): Promise<EvidenceIndex> {
    validateId(runId, "runId");
    try {
      return JSON.parse(await fs.readFile(this.indexPath(runId), "utf-8")) as EvidenceIndex;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          run_id: runId, partial: true,
          updated_at: new Date().toISOString(),
          root_path: this.runDir(runId), refs: [], key_events: [],
        };
      }
      // Parse/permission error — surface it, don't silently rebuild
      throw new Error(`Corrupted evidence index for run ${runId}: ${(e as Error).message}`);
    }
  }

  async updateKeyEvents(runId: string, keyEvent: KeyEvent): Promise<void> {
    validateId(runId, "runId");
    await this.serializedIndex(runId, async () => {
      const idx = await this.getIndex(runId);
      idx.key_events.push(keyEvent);
      idx.updated_at = new Date().toISOString();
      await this.writeIndex(runId, idx);
    });
  }

  // --- Retention / Cleanup ---

  /** Clean up evidence older than the configured retention policy. Important evidence is preserved. */
  async cleanup(retention?: Partial<RetentionConfig>): Promise<{ removed_runs: number; removed_bytes: number }> {
    const cfg = { ...this.retention, ...retention };
    let removedRuns = 0;
    let removedBytes = 0;

    const runsDir = path.join(this.dataRoot, "runs");
    let entries: string[];
    try { entries = await fs.readdir(runsDir); } catch { return { removed_runs: 0, removed_bytes: 0 }; }

    const now = Date.now();
    for (const entry of entries) {
      const runDir = path.join(runsDir, entry);
      try {
        const idx = await this.getIndex(entry);
        const idxTime = new Date(idx.updated_at).getTime();
        const maxAge = idx.partial ? cfg.failure_days : cfg.success_days;
        const ageDays = (now - idxTime) / (1000 * 60 * 60 * 24);

        if (ageDays < maxAge) continue;

        // Check if any evidence is marked important
        if (idx.refs.some(r => r.important)) continue;

        // Delete only evidence files, not run metadata (run.json, events.jsonl, brain/)
        for (const ref of idx.refs) {
          try {
            const filePath = path.join(runDir, ref.path);
            await fs.rm(filePath, { force: true });
            removedBytes += ref.bytes ?? 0;
          } catch { /* file already gone */ }
        }
        // Remove the evidence index itself (evidence is gone)
        try { await fs.rm(path.join(runDir, "evidence-index.json"), { force: true }); } catch { /* ok */ }
        // Remove empty snapshots directory
        try { await fs.rmdir(path.join(runDir, "snapshots")); } catch { /* not empty or not exist */ }
        removedRuns++;
      } catch { /* skip corrupted entries */ }
    }

    return { removed_runs: removedRuns, removed_bytes: removedBytes };
  }

  // --- Private ---

  private async addRef(runId: string, ref: EvidenceRef): Promise<void> {
    await this.serializedIndex(runId, async () => {
      const idx = await this.getIndex(runId);
      const existing = idx.refs.findIndex(r => r.ref === ref.ref);
      if (existing >= 0) idx.refs[existing] = ref;
      else idx.refs.push(ref);
      idx.updated_at = new Date().toISOString();
      await this.writeIndex(runId, idx);
    });
  }

  private async writeIndex(runId: string, idx: EvidenceIndex): Promise<void> {
    const filePath = this.indexPath(runId);
    // Uses writeAtomic which has unique temp paths — safe under concurrency
    await writeAtomic(filePath, JSON.stringify(idx, null, 2));
  }

  private refToFile(ref: string): string {
    if (ref.includes("last") || ref.includes("window")) return `snapshots/${ref.replace(/:/g, "-")}.log`;
    if (ref === "serial:full") return "serial.log";
    if (ref === "dmesg:full") return "dmesg.log";
    if (ref === "logcat:full") return "logcat.log";
    if (ref === "flash:full") return "flash.log";
    if (ref.startsWith("adb-")) return `${ref.split(":")[0]}.json`;
    return `${ref.replace(/:/g, "-")}.log`;
  }

  private refKind(ref: string): "log" | "window" | "snapshot" {
    if (ref.includes("window") || ref.includes("last")) return "window";
    if (ref.includes("snapshot")) return "snapshot";
    return "log";
  }
}
