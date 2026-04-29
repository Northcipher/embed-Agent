import path from "node:path";
import fs from "node:fs/promises";

const DATA_ROOT = ".embed-agent";

export function getDataRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, DATA_ROOT);
}

export function getRunDir(dataRoot: string, runId: string): string {
  return path.join(dataRoot, "runs", runId);
}

export function getTargetDir(dataRoot: string): string {
  return path.join(dataRoot, "targets");
}

export function getMemoryDir(dataRoot: string): string {
  return path.join(dataRoot, "memory");
}

export function getSkillsDir(dataRoot: string): string {
  return path.join(dataRoot, "skills");
}

export function getEventsPath(dataRoot: string): string {
  return path.join(dataRoot, "events.jsonl");
}

export async function initLayout(dataRoot: string): Promise<void> {
  await fs.mkdir(path.join(dataRoot, "runs"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "targets"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "memory", "working-memory"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "memory", "run-profiles"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "skills", "custom"), { recursive: true });
}
