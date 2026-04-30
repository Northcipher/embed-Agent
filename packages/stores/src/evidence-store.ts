import fs from "node:fs/promises";
import path from "node:path";

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
  constructor(private dataRoot = ".embed-agent") {}

  private runDir(runId: string): string {
    return path.join(this.dataRoot, "runs", runId);
  }

  private indexPath(runId: string): string {
    return path.join(this.runDir(runId), "evidence-index.json");
  }

  async write(runId: string, ref: string, data: string | Buffer): Promise<{ filePath: string; bytes: number }> {
    const dir = this.runDir(runId);
    await fs.mkdir(path.join(dir, "snapshots"), { recursive: true });

    const fileName = this.refToFile(ref);
    const filePath = path.join(dir, fileName);
    const tmpPath = filePath + ".tmp";

    const content = typeof data === "string" ? Buffer.from(data) : data;
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, filePath);

    const refObj: EvidenceRef = { ref, kind: this.refKind(ref), path: fileName, available: true, bytes: content.length };
    await this.addRef(runId, refObj);

    return { filePath, bytes: content.length };
  }

  async read(runId: string, ref: string): Promise<{ filePath: string; size: number; available: boolean }> {
    const filePath = path.join(this.runDir(runId), this.refToFile(ref));
    try {
      const stat = await fs.stat(filePath);
      return { filePath, size: stat.size, available: true };
    } catch {
      return { filePath, size: 0, available: false };
    }
  }

  async getIndex(runId: string): Promise<EvidenceIndex> {
    try {
      return JSON.parse(await fs.readFile(this.indexPath(runId), "utf-8")) as EvidenceIndex;
    } catch {
      return {
        run_id: runId, partial: true,
        updated_at: new Date().toISOString(),
        root_path: this.runDir(runId), refs: [], key_events: [],
      };
    }
  }

  async updateKeyEvents(runId: string, keyEvent: KeyEvent): Promise<void> {
    const idx = await this.getIndex(runId);
    idx.key_events.push(keyEvent);
    idx.updated_at = new Date().toISOString();
    await this.writeIndex(runId, idx);
  }

  private async addRef(runId: string, ref: EvidenceRef): Promise<void> {
    const idx = await this.getIndex(runId);
    const existing = idx.refs.findIndex(r => r.ref === ref.ref);
    if (existing >= 0) idx.refs[existing] = ref;
    else idx.refs.push(ref);
    idx.updated_at = new Date().toISOString();
    await this.writeIndex(runId, idx);
  }

  private async writeIndex(runId: string, idx: EvidenceIndex): Promise<void> {
    const filePath = this.indexPath(runId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath + ".tmp", JSON.stringify(idx, null, 2), "utf-8");
    await fs.rename(filePath + ".tmp", filePath);
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
