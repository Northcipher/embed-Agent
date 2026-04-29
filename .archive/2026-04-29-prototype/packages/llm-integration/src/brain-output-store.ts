import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmRole } from "./types.js";

export const BrainCallStatusSchema = z.enum(["validated", "parse_failed", "validation_failed", "timeout", "provider_error"]);

export const BrainCallRecordSchema = z
  .object({
    call_id: z.string().min(1),
    role: z.enum(["task_planner", "observer", "reply_generator"]),
    prompt_id: z.string().min(1),
    started_at: z.string().min(1),
    ended_at: z.string().min(1),
    status: BrainCallStatusSchema,
    provider_id: z.string().min(1).optional(),
    model: z.string().min(1),
    input_ref: z.string().min(1),
    raw_output_ref: z.string().min(1).optional(),
    parsed_output_ref: z.string().min(1).optional(),
    validation_ref: z.string().min(1)
  })
  .strict();

export type BrainCallStatus = z.infer<typeof BrainCallStatusSchema>;
export type BrainCallRecord = z.infer<typeof BrainCallRecordSchema>;

export type BrainOutputStoreOptions = {
  runDir: string;
};

export type WriteBrainCallInput = {
  callId: string;
  role: LlmRole;
  promptId: string;
  startedAt: string;
  endedAt: string;
  status: BrainCallStatus;
  providerId?: string;
  model: string;
  input: unknown;
  rawOutput?: string;
  parsedOutput?: unknown;
  validation: unknown;
};

export type WriteBrainCallResult = {
  record: BrainCallRecord;
};

const appendQueues = new Map<string, Promise<void>>();

export class BrainOutputStore {
  private readonly runDir: string;

  constructor(options: BrainOutputStoreOptions) {
    this.runDir = path.resolve(options.runDir);
  }

  brainDir(): string {
    return path.join(this.runDir, "brain");
  }

  async writeCall(input: WriteBrainCallInput): Promise<WriteBrainCallResult> {
    const callId = safeSegment(input.callId, "call_id");
    const inputRef = brainRef(`${callId}.input.json`);
    const rawOutputRef = input.rawOutput === undefined ? undefined : brainRef(`${callId}.raw.txt`);
    const parsedOutputRef = input.parsedOutput === undefined ? undefined : brainRef(`${callId}.parsed.json`);
    const validationRef = brainRef(`${callId}.validation.json`);

    await this.writeJsonAtomic(this.resolveBrainRef(inputRef), input.input);
    if (input.rawOutput !== undefined) {
      await this.writeFileAtomic(this.resolveBrainRef(rawOutputRef!), input.rawOutput);
    }
    if (input.parsedOutput !== undefined) {
      await this.writeJsonAtomic(this.resolveBrainRef(parsedOutputRef!), input.parsedOutput);
    }
    await this.writeJsonAtomic(this.resolveBrainRef(validationRef), input.validation);

    const record = BrainCallRecordSchema.parse({
      call_id: callId,
      role: input.role,
      prompt_id: input.promptId,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      status: input.status,
      provider_id: input.providerId,
      model: input.model,
      input_ref: inputRef,
      raw_output_ref: rawOutputRef,
      parsed_output_ref: parsedOutputRef,
      validation_ref: validationRef
    });
    await mkdir(this.brainDir(), { recursive: true });
    await enqueueAppend(this.resolveBrainRef("brain/calls.jsonl"), `${JSON.stringify(record)}\n`);

    return { record };
  }

  async readCallRecords(): Promise<BrainCallRecord[]> {
    const filePath = this.resolveBrainRef("brain/calls.jsonl");
    const content = await readFile(filePath, "utf8");
    const records: BrainCallRecord[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      records.push(BrainCallRecordSchema.parse(JSON.parse(line)));
    }
    return records;
  }

  private resolveBrainRef(ref: string): string {
    if (path.isAbsolute(ref)) {
      throw new Error("Brain output ref must be relative");
    }
    const normalized = path.normalize(ref);
    if (!normalized.startsWith(`brain${path.sep}`)) {
      throw new Error("Brain output ref must stay inside the run directory");
    }
    return path.join(this.runDir, normalized);
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
}

function brainRef(filename: string): string {
  return `brain/${filename}`;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

async function enqueueAppend(filePath: string, line: string): Promise<void> {
  const previous = appendQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => appendFile(filePath, line, "utf8"));
  appendQueues.set(
    filePath,
    current.finally(() => {
      if (appendQueues.get(filePath) === current) {
        appendQueues.delete(filePath);
      }
    })
  );
  return current;
}
