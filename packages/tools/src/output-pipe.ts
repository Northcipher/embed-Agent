import type { RingBuffer } from "./ring-buffer.js";

interface Emitter { emit(e: Record<string, unknown>): void; }
interface EvidenceWriter { append(d: string): void; }
interface LineDetector { detect(line: string, idx: number): void; checkExitCode?(c: number): void; }
interface LineAggregator { feed(line: string): void; onExecComplete?(sid: string): void; }

export class OutputPipe {
  private buf = "";
  private batch = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ew: EvidenceWriter,
    private rb: RingBuffer,
    private rd: LineDetector,
    private ag: LineAggregator,
    private eb: Emitter,
    private stepId: string,
    private silenceMs = 60000,
  ) {}

  feedStream(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      this.ew.append(line + "\n");
      this.rb.push(line);
      this.rd.detect(line, this.rb.totalPushed() - 1);
      this.ag.feed(line);
    }

    this.batch += lines.length;
    if (this.batch >= 100) { this.eb.emit({ type: "observation", lines: this.batch }); this.batch = 0; }

    if (lines.length > 0) this.resetSilence();
  }

  feedExec(stdout: string, stderr: string, exitCode: number): void {
    const lines = (stdout + "\n" + stderr).split("\n").filter(l => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      this.ew.append(line + "\n");
      this.rb.push(line);
      this.rd.detect(line, this.rb.totalPushed() - 1);
      this.ag.feed(line);
    }
    this.rd.checkExitCode?.(exitCode);
    this.eb.emit({ type: "observation" });
    this.ag.onExecComplete?.(this.stepId);
  }

  disableSilence(): void { if (this.silenceTimer) clearTimeout(this.silenceTimer); }

  private resetSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.eb.emit({ type: "rule_matched", rule_id: "serial_silence", severity: "warning", summary: "serial silence detected", payload: {} });
    }, this.silenceMs);
  }
}
