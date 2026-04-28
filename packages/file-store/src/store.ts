import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EvidenceIndexSchema,
  type EvidenceIndex,
  type EvidenceRef,
  EvidenceRefSchema,
  type EventType,
  KeyEventSchema,
  type KeyEvent,
  RunEventSchema,
  RunStateSchema,
  type RunEvent,
  type RunState
} from "@artifact-validation/contracts";
import { z } from "zod";

export const StoredRunSchema = z
  .object({
    run_id: z.string().min(1),
    status: RunStateSchema,
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    evidence_path: z.string().min(1),
    last_event_seq: z.number().int().nonnegative()
  })
  .strict();

export type StoredRun = z.infer<typeof StoredRunSchema>;

export type FileStoreOptions = {
  rootDir: string;
  now?: () => Date;
};

export type CreateRunInput = {
  run_id: string;
  status?: RunState;
  request?: unknown;
  targetProfile?: unknown;
  inferredCapabilities?: unknown;
};

export type AppendEventInput = Omit<RunEvent, "seq" | "run_id">;

export type ReadEventsOptions = {
  afterSeq?: number;
  limit?: number;
  types?: EventType[];
};

export class FileStore {
  readonly rootDir: string;

  private readonly now: () => Date;

  constructor(options: FileStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
  }

  runsDir(): string {
    return path.join(this.rootDir, "runs");
  }

  runDir(runId: string): string {
    assertSafeId(runId, "run_id");
    return path.join(this.runsDir(), runId);
  }

  async createRun(input: CreateRunInput): Promise<StoredRun> {
    const runDir = this.runDir(input.run_id);
    await mkdir(path.join(runDir, "snapshots"), { recursive: true });

    const time = this.isoNow();
    const run = StoredRunSchema.parse({
      run_id: input.run_id,
      status: input.status ?? "queued",
      created_at: time,
      updated_at: time,
      evidence_path: runDir,
      last_event_seq: 0
    });

    await this.writeJsonAtomic(path.join(runDir, "run.json"), run);
    await this.writeJsonAtomic(path.join(runDir, "evidence-index.json"), this.emptyEvidenceIndex(input.run_id));
    await writeFile(path.join(runDir, "events.jsonl"), "", { flag: "a" });

    if (input.request !== undefined) {
      await this.writeJsonAtomic(path.join(runDir, "request.json"), input.request);
    }
    if (input.targetProfile !== undefined) {
      await this.writeJsonAtomic(path.join(runDir, "target-profile.json"), input.targetProfile);
    }
    if (input.inferredCapabilities !== undefined) {
      await this.writeJsonAtomic(path.join(runDir, "inferred-capabilities.json"), input.inferredCapabilities);
    }

    return run;
  }

  async readRun(runId: string): Promise<StoredRun> {
    const raw = await this.readJson(path.join(this.runDir(runId), "run.json"));
    return StoredRunSchema.parse(raw);
  }

  async writeRun(run: StoredRun): Promise<StoredRun> {
    const parsed = StoredRunSchema.parse({
      ...run,
      updated_at: this.isoNow()
    });
    await this.writeJsonAtomic(path.join(this.runDir(parsed.run_id), "run.json"), parsed);
    return parsed;
  }

  async appendEvent(runId: string, event: AppendEventInput): Promise<RunEvent> {
    const run = await this.readRun(runId);
    const nextSeq = run.last_event_seq + 1;
    const parsed = RunEventSchema.parse({ ...event, run_id: runId, seq: nextSeq });
    await appendFile(path.join(this.runDir(runId), "events.jsonl"), `${JSON.stringify(parsed)}\n`, "utf8");
    await this.writeRun({ ...run, last_event_seq: nextSeq });
    return parsed;
  }

  async readEvents(runId: string, options: ReadEventsOptions = {}): Promise<RunEvent[]> {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 100;
    const types = new Set(options.types ?? []);
    const content = await readFile(path.join(this.runDir(runId), "events.jsonl"), "utf8");
    const events: RunEvent[] = [];

    for (const line of content.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const event = RunEventSchema.parse(JSON.parse(line));
      if (event.seq <= afterSeq) {
        continue;
      }
      if (types.size > 0 && !types.has(event.type)) {
        continue;
      }
      events.push(event);
      if (events.length >= limit) {
        break;
      }
    }

    return events;
  }

  async readEvidenceIndex(runId: string): Promise<EvidenceIndex> {
    const raw = await this.readJson(path.join(this.runDir(runId), "evidence-index.json"));
    return EvidenceIndexSchema.parse(raw);
  }

  async addEvidenceRef(runId: string, ref: EvidenceRef, content?: string | Uint8Array): Promise<EvidenceIndex> {
    const parsedRef = EvidenceRefSchema.parse(ref);
    const evidencePath = this.resolveRunRelativePath(runId, parsedRef.path);

    if (content !== undefined) {
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await this.writeFileAtomic(evidencePath, content);
    } else {
      await assertFileExists(evidencePath);
    }

    const index = await this.readEvidenceIndex(runId);
    const updatedRefs = [...index.refs.filter(existing => existing.ref !== parsedRef.ref), parsedRef];
    const updated = EvidenceIndexSchema.parse({
      ...index,
      partial: true,
      updated_at: this.isoNow(),
      refs: updatedRefs
    });
    await this.writeJsonAtomic(path.join(this.runDir(runId), "evidence-index.json"), updated);
    return updated;
  }

  async addKeyEvent(runId: string, keyEvent: KeyEvent): Promise<EvidenceIndex> {
    const parsedKeyEvent = KeyEventSchema.parse(keyEvent);
    const index = await this.readEvidenceIndex(runId);
    const withoutDuplicate = index.key_events.filter(existing => existing.seq !== parsedKeyEvent.seq);
    const updated = EvidenceIndexSchema.parse({
      ...index,
      updated_at: this.isoNow(),
      key_events: [...withoutDuplicate, parsedKeyEvent].sort((left, right) => left.seq - right.seq)
    });
    await this.writeJsonAtomic(path.join(this.runDir(runId), "evidence-index.json"), updated);
    return updated;
  }

  private emptyEvidenceIndex(runId: string): EvidenceIndex {
    return EvidenceIndexSchema.parse({
      run_id: runId,
      partial: true,
      updated_at: this.isoNow(),
      root_path: this.runDir(runId),
      refs: [],
      key_events: []
    });
  }

  private resolveRunRelativePath(runId: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error("Evidence path must be relative to the run directory");
    }
    const normalized = path.normalize(relativePath);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new Error("Evidence path must stay inside the run directory");
    }
    return path.join(this.runDir(runId), normalized);
  }

  private async readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await readFile(filePath, "utf8"));
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await this.writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeFileAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, content);
    await rename(tempPath, filePath);
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

async function assertFileExists(filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Evidence path is not a file: ${filePath}`);
  }
}
