import fs from "node:fs/promises";
import path from "node:path";
import { getRunDir, getEventsPath } from "./layout.js";
import type { Event } from "@embed-agent/contracts";

function eventsFile(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

export class EventStore {
  constructor(private dataRoot: string) {}

  async append(runId: string, event: Event): Promise<{ seq: number }> {
    const runDir = getRunDir(this.dataRoot, runId);
    await fs.mkdir(runDir, { recursive: true });
    const file = eventsFile(runDir);

    // Read last seq
    let lastSeq = 0;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 0) {
        const lastLine = await this.readLastLine(file);
        if (lastLine) {
          const lastEvent = JSON.parse(lastLine) as Event;
          lastSeq = lastEvent.seq;
        }
      }
    } catch {
      // File doesn't exist yet, start at seq 0
    }

    const seq = lastSeq + 1;
    const time = new Date().toISOString();
    const record = JSON.stringify({ ...event, seq, time }) + "\n";

    await fs.appendFile(file, record, "utf-8");
    return { seq };
  }

  async appendGlobal(event: Event): Promise<{ seq: number }> {
    const file = getEventsPath(this.dataRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });

    let lastSeq = 0;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 0) {
        const lastLine = await this.readLastLine(file);
        if (lastLine) {
          const lastEvent = JSON.parse(lastLine) as Event;
          lastSeq = lastEvent.seq;
        }
      }
    } catch {
      // File doesn't exist, start at 0
    }

    const seq = lastSeq + 1;
    const time = new Date().toISOString();
    const record = JSON.stringify({ ...event, seq, time }) + "\n";

    await fs.appendFile(file, record, "utf-8");
    return { seq };
  }

  async read(runId: string, afterSeq = 0, limit = 100): Promise<Event[]> {
    const runDir = getRunDir(this.dataRoot, runId);
    const file = eventsFile(runDir);
    try {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.trim().split("\n");
      return lines
        .map(line => JSON.parse(line) as Event)
        .filter(e => e.seq > afterSeq)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  async readGlobal(afterSeq = 0, limit = 100): Promise<Event[]> {
    const file = getEventsPath(this.dataRoot);
    try {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.trim().split("\n");
      return lines
        .map(line => JSON.parse(line) as Event)
        .filter(e => e.seq > afterSeq)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  private async readLastLine(filePath: string): Promise<string | null> {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) return null;
    return lines[lines.length - 1]!;
  }
}
