import fs from "node:fs/promises";
import path from "node:path";
import { getRunDir } from "./layout.js";

export interface EvidenceRef {
  ref: string;
  kind: "log" | "window" | "snapshot";
  path: string;
  available: boolean;
  bytes?: number;
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

export class EvidenceStore {
  constructor(private dataRoot: string) {}

  async write(runId: string, ref: string, data: string | Buffer): Promise<{ filePath: string; bytes: number }> {
    const runDir = getRunDir(this.dataRoot, runId);
    await fs.mkdir(runDir, { recursive: true });

    const fileName = this.refToFileName(ref);
    const filePath = path.join(runDir, fileName);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const content = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, filePath);
    await this.addRef(runId, { ref, kind: this.refToKind(ref), path: fileName, available: true, bytes: content.length });
    return { filePath, bytes: content.length };
  }

  async read(runId: string, ref: string): Promise<{ filePath: string; size: number; available: boolean }> {
    const runDir = getRunDir(this.dataRoot, runId);
    const fileName = this.refToFileName(ref);
    const filePath = path.join(runDir, fileName);
    try {
      const stat = await fs.stat(filePath);
      return { filePath, size: stat.size, available: true };
    } catch {
      return { filePath, size: 0, available: false };
    }
  }

  async getIndex(runId: string): Promise<EvidenceIndex> {
    const filePath = this.indexPath(runId);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as EvidenceIndex;
    } catch {
      return {
        run_id: runId, partial: true,
        updated_at: new Date().toISOString(),
        root_path: getRunDir(this.dataRoot, runId),
        refs: [], key_events: [],
      };
    }
  }

  async updateKeyEvents(runId: string, keyEvent: KeyEvent): Promise<void> {
    const index = await this.getIndex(runId);
    index.key_events.push(keyEvent);
    index.updated_at = new Date().toISOString();
    await this.writeIndex(runId, index);
  }

  private async addRef(runId: string, ref: EvidenceRef): Promise<void> {
    const index = await this.getIndex(runId);
    const existing = index.refs.findIndex(r => r.ref === ref.ref);
    if (existing >= 0) {
      index.refs[existing] = ref;
    } else {
      index.refs.push(ref);
    }
    index.updated_at = new Date().toISOString();
    await this.writeIndex(runId, index);
  }

  private async writeIndex(runId: string, index: EvidenceIndex): Promise<void> {
    const filePath = this.indexPath(runId);
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  private indexPath(runId: string): string {
    return path.join(getRunDir(this.dataRoot, runId), "evidence-index.json");
  }

  private refToFileName(ref: string): string {
    if (ref.includes("last") || ref.includes("window")) return `snapshots/${ref.replace(/:/g, "-")}.log`;
    if (ref === "serial:full") return "serial.log";
    if (ref === "dmesg:full") return "dmesg.log";
    if (ref === "logcat:full") return "logcat.log";
    if (ref === "flash:full") return "flash.log";
    if (ref.startsWith("adb-")) return `${ref.split(":")[0]}.json`;
    return `${ref.replace(/:/g, "-")}.log`;
  }

  private refToKind(ref: string): "log" | "window" | "snapshot" {
    if (ref.includes("window") || ref.includes("last")) return "window";
    if (ref.includes("snapshot")) return "snapshot";
    return "log";
  }
}
