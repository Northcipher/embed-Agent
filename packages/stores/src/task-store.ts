// Simple task store — JSON file CRUD for scheduled validation tasks.
import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";

export type TaskTrigger =
  | { kind: "cron"; cron: string; timezone?: string }
  | { kind: "file_event"; pattern: string }
  | { kind: "continuous" };

export interface TaskValidationSpec {
  artifact: { path: string; type: string; version?: string; build_id?: string };
  target: string;
  expected: string;
  task?: string;
  reply_language?: "zh" | "en";
  concerns?: string[];
  success_criteria?: string[];
  failure_criteria?: string[];
  constraints?: {
    max_duration_sec?: number;
    allow_flash?: boolean;
    allow_shell_exec?: boolean;
    no_flash?: boolean;
    continuous?: boolean;
  };
}

export interface TaskPolicy {
  overlap: "skip_if_target_busy" | "queue_next_run" | "cancel_older_run";
  failure: "notify_and_keep_enabled" | "pause_after_3_failures" | "collect_extra_evidence";
}

export interface TaskRecord {
  name: string;
  validation_spec: TaskValidationSpec;
  trigger: TaskTrigger;
  policy: TaskPolicy;
  enabled: boolean;
  lastRun?: string;      // ISO timestamp
  lastRunId?: string;    // run_id of last execution
  createdAt: string;
  updatedAt?: string;

  // Legacy fields kept optional so existing tasks.json files continue to load.
  cron?: string;
  target?: string;
  artifactPath?: string;
  artifactType?: string;
  expected?: string;
}

export class TaskStore {
  constructor(private dataRoot: string) {}

  private filePath(): string {
    return path.join(this.dataRoot, "tasks.json");
  }

  async list(): Promise<TaskRecord[]> {
    try {
      const data = await fs.readFile(this.filePath(), "utf-8");
      const parsed = JSON.parse(data) as unknown[];
      return parsed.map((item) => normalizeTaskRecord(item)).filter((task): task is TaskRecord => task !== null);
    } catch { return []; }
  }

  async get(name: string): Promise<TaskRecord | null> {
    return (await this.list()).find(t => t.name === name) ?? null;
  }

  async add(task: TaskRecord): Promise<void> {
    const tasks = await this.list();
    const existing = tasks.findIndex(t => t.name === task.name);
    if (existing >= 0) tasks[existing] = task;
    else tasks.push(task);
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
  }

  async update(name: string, patch: Partial<Omit<TaskRecord, "name" | "createdAt">>): Promise<TaskRecord | null> {
    const tasks = await this.list();
    const existing = tasks.findIndex(t => t.name === name);
    if (existing < 0) return null;
    const current = tasks[existing]!;
    const next: TaskRecord = {
      ...current,
      ...patch,
      validation_spec: patch.validation_spec ?? current.validation_spec,
      trigger: patch.trigger ?? current.trigger,
      policy: patch.policy ?? current.policy,
      updatedAt: new Date().toISOString(),
    };
    tasks[existing] = next;
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
    return next;
  }

  async remove(name: string): Promise<void> {
    const tasks = (await this.list()).filter(t => t.name !== name);
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
  }

  async updateLastRun(name: string, runId: string): Promise<void> {
    const tasks = await this.list();
    const t = tasks.find(t => t.name === name);
    if (t) { t.lastRun = new Date().toISOString(); t.lastRunId = runId; }
    await writeAtomic(this.filePath(), JSON.stringify(tasks, null, 2));
  }
}

function normalizeTaskRecord(item: unknown): TaskRecord | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  if (typeof raw["name"] !== "string" || !raw["name"]) return null;

  const validationSpec = normalizeValidationSpec(raw["validation_spec"]);
  const legacyTarget = typeof raw["target"] === "string" ? raw["target"] : "";
  const legacyArtifactPath = typeof raw["artifactPath"] === "string" ? raw["artifactPath"] : "";
  const legacyArtifactType = typeof raw["artifactType"] === "string" ? raw["artifactType"] : "firmware";
  const legacyExpected = typeof raw["expected"] === "string" ? raw["expected"] : "";
  const fallbackSpec = legacyTarget && legacyArtifactPath && legacyExpected ? {
    target: legacyTarget,
    artifact: { path: legacyArtifactPath, type: legacyArtifactType },
    expected: legacyExpected,
  } : null;
  const spec = validationSpec ?? fallbackSpec;
  if (!spec) return null;

  const trigger = normalizeTrigger(raw["trigger"]) ?? (
    typeof raw["cron"] === "string" ? { kind: "cron" as const, cron: raw["cron"] } : { kind: "cron" as const, cron: "0 2 * * *" }
  );
  const policy = normalizePolicy(raw["policy"]);
  const task: TaskRecord = {
    name: raw["name"],
    validation_spec: spec,
    trigger,
    policy,
    enabled: typeof raw["enabled"] === "boolean" ? raw["enabled"] : true,
    createdAt: typeof raw["createdAt"] === "string" ? raw["createdAt"] : new Date().toISOString(),
  };
  if (typeof raw["lastRun"] === "string") task.lastRun = raw["lastRun"];
  if (typeof raw["lastRunId"] === "string") task.lastRunId = raw["lastRunId"];
  if (typeof raw["updatedAt"] === "string") task.updatedAt = raw["updatedAt"];
  return task;
}

function normalizeValidationSpec(value: unknown): TaskValidationSpec | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const artifact = raw["artifact"];
  if (!artifact || typeof artifact !== "object") return null;
  const artifactRaw = artifact as Record<string, unknown>;
  if (typeof raw["target"] !== "string" || !raw["target"]) return null;
  if (typeof raw["expected"] !== "string" || !raw["expected"]) return null;
  if (typeof artifactRaw["path"] !== "string" || !artifactRaw["path"]) return null;

  const spec: TaskValidationSpec = {
    target: raw["target"],
    artifact: {
      path: artifactRaw["path"],
      type: typeof artifactRaw["type"] === "string" && artifactRaw["type"] ? artifactRaw["type"] : "firmware",
    },
    expected: raw["expected"],
  };
  if (typeof raw["task"] === "string" && raw["task"]) spec.task = raw["task"];
  if (typeof artifactRaw["version"] === "string") spec.artifact.version = artifactRaw["version"];
  if (typeof artifactRaw["build_id"] === "string") spec.artifact.build_id = artifactRaw["build_id"];
  if (raw["reply_language"] === "zh" || raw["reply_language"] === "en") spec.reply_language = raw["reply_language"];
  if (Array.isArray(raw["concerns"])) spec.concerns = raw["concerns"].filter((item): item is string => typeof item === "string");
  if (Array.isArray(raw["success_criteria"])) spec.success_criteria = raw["success_criteria"].filter((item): item is string => typeof item === "string");
  if (Array.isArray(raw["failure_criteria"])) spec.failure_criteria = raw["failure_criteria"].filter((item): item is string => typeof item === "string");
  if (raw["constraints"] && typeof raw["constraints"] === "object") {
    spec.constraints = raw["constraints"] as NonNullable<TaskValidationSpec["constraints"]>;
  }
  return spec;
}

function normalizeTrigger(value: unknown): TaskTrigger | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] === "cron" && typeof raw["cron"] === "string" && raw["cron"]) {
    const trigger: TaskTrigger = { kind: "cron", cron: raw["cron"] };
    if (typeof raw["timezone"] === "string") trigger.timezone = raw["timezone"];
    return trigger;
  }
  if (raw["kind"] === "file_event" && typeof raw["pattern"] === "string" && raw["pattern"]) return { kind: "file_event", pattern: raw["pattern"] };
  if (raw["kind"] === "continuous") return { kind: "continuous" };
  return null;
}

function normalizePolicy(value: unknown): TaskPolicy {
  if (!value || typeof value !== "object") return { overlap: "skip_if_target_busy", failure: "notify_and_keep_enabled" };
  const raw = value as Record<string, unknown>;
  const overlap = raw["overlap"] === "queue_next_run" || raw["overlap"] === "cancel_older_run" ? raw["overlap"] : "skip_if_target_busy";
  const failure = raw["failure"] === "pause_after_3_failures" || raw["failure"] === "collect_extra_evidence" ? raw["failure"] : "notify_and_keep_enabled";
  return { overlap, failure };
}
