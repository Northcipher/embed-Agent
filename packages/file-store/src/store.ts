import { appendFile, mkdir, open, readFile, rename, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  AgentReplySchema,
  type AgentReply,
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

  async readRunRequest(runId: string): Promise<unknown | undefined> {
    try {
      return await this.readJson(path.join(this.runDir(runId), "request.json"));
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
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
    await this.addKeyEventFromRunEvent(parsed);
    return parsed;
  }

  async readEvents(runId: string, options: ReadEventsOptions = {}): Promise<RunEvent[]> {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 100;
    const types = new Set(options.types ?? []);
    const events: RunEvent[] = [];

    const filePath = path.join(this.runDir(runId), "events.jsonl");
    const file = await open(filePath, "r");
    try {
      const endsWithNewline = await fileEndsWithNewline(file);
      let pendingLine: string | undefined;
      for await (const line of file.readLines({ encoding: "utf8" })) {
        if (pendingLine !== undefined) {
          appendParsedEvent(events, pendingLine, afterSeq, limit, types, "complete");
          if (events.length >= limit) {
            break;
          }
        }
        pendingLine = line;
      }
      if (pendingLine !== undefined && events.length < limit) {
        appendParsedEvent(events, pendingLine, afterSeq, limit, types, endsWithNewline ? "complete" : "maybe-incomplete");
      }
    } finally {
      await file.close();
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

  private async addKeyEventFromRunEvent(event: RunEvent): Promise<void> {
    if (!shouldPromoteEventToKeyEvent(event)) {
      return;
    }
    await this.addKeyEvent(event.run_id, {
      seq: event.seq,
      summary: event.summary,
      evidence_refs: event.evidence_refs
    });
  }

  async writeAgentReply(runId: string, reply: AgentReply): Promise<AgentReply> {
    const parsed = AgentReplySchema.parse(reply);
    await this.writeJsonAtomic(path.join(this.runDir(runId), "reply.json"), parsed);
    return parsed;
  }

  async readAgentReply(runId: string): Promise<AgentReply | undefined> {
    try {
      const raw = await this.readJson(path.join(this.runDir(runId), "reply.json"));
      return AgentReplySchema.parse(raw);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
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

async function fileEndsWithNewline(file: FileHandle): Promise<boolean> {
  const stats = await file.stat();
  if (stats.size === 0) {
    return true;
  }
  const buffer = Buffer.alloc(1);
  await file.read({ buffer, position: stats.size - 1, length: 1 });
  return buffer[0] === 10;
}

function appendParsedEvent(
  events: RunEvent[],
  line: string,
  afterSeq: number,
  limit: number,
  types: Set<EventType>,
  lineState: "complete" | "maybe-incomplete"
): void {
  if (line.trim().length === 0) {
    return;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    if (lineState === "maybe-incomplete") {
      return;
    }
    throw new Error(`Invalid events.jsonl line: ${truncateForError(line)}`);
  }
  const event = RunEventSchema.parse(decoded);
  if (event.seq <= afterSeq) {
    return;
  }
  if (types.size > 0 && !types.has(event.type)) {
    return;
  }
  if (events.length < limit) {
    events.push(event);
  }
}

function truncateForError(text: string, maxLength = 160): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function shouldPromoteEventToKeyEvent(event: RunEvent): event is RunEvent & { evidence_refs: string[] } {
  if (event.evidence_refs === undefined || event.evidence_refs.length === 0) {
    return false;
  }
  return event.type === "rule_matched" || event.severity === "warning" || event.severity === "error";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
