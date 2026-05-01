import type { RingBuffer } from "./ring-buffer.js";

interface Emitter { emit(e: Record<string, unknown>): void; }
interface EvidenceWriter { append(d: string): void; }
interface LineDetector { detect(line: string, idx: number): void; flushPending(): Promise<void>; flushAllPending(): Promise<void>; checkExitCode?(c: number): void; checkSilence?(connected: boolean, silenceMs: number): void; }
interface LineAggregator { feed(line: string): void; onExecComplete?(sid: string, exitCode?: number, source?: string): void; }
interface ConnectionState { state(): "connected" | "disconnected" | "error"; }

export class OutputPipe {
  private buf = "";
  private batch = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceAt = 0;
  private conn?: ConnectionState;
  private runId?: string;

  constructor(
    private ew: EvidenceWriter,
    private rb: RingBuffer,
    private rd: LineDetector,
    private ag: LineAggregator,
    private eb: Emitter,
    private stepId: string,
    private silenceMs = 60000,
  ) {}

  /** Set the run ID for observation event attribution. */
  setRunId(runId: string): void { this.runId = runId; }

  /** Set the connection for silence detection — only fires when connected. */
  setConnection(conn: ConnectionState): void { this.conn = conn; }

  async feedStream(chunk: string): Promise<void> {
    this.buf += chunk;
    // Guard against unbounded growth on binary/long-line input
    const maxBuf = 256 * 1024; // 256KB max for a single partial line
    if (this.buf.length > maxBuf) {
      this.ew.append(this.buf.slice(0, maxBuf) + "\n[TRUNCATED]\n");
      this.buf = this.buf.slice(-4096); // keep trailing 4KB for context
    }
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      this.ew.append(line + "\n");
      this.rb.push(line);
      await this.rd.flushPending();
      this.rd.detect(line, this.rb.totalPushed() - 1);
      this.ag.feed(line);
    }

    this.batch += lines.length;
    if (this.batch >= 100) {
      this.eb.emit({
        type: "observation", run_id: this.runId, source: "output_pipe",
        summary: `${this.batch} lines processed`,
        payload: { lines: this.batch, step_id: this.stepId },
      });
      this.batch = 0;
    }

    if (lines.length > 0) this.resetSilence();
  }

  async feedExec(stdout: string, stderr: string, exitCode: number): Promise<void> {
    const lines = (stdout + "\n" + stderr).split("\n").filter(l => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      this.ew.append(line + "\n");
      this.rb.push(line);
      await this.rd.flushPending();
      this.rd.detect(line, this.rb.totalPushed() - 1);
      this.ag.feed(line);
    }
    await this.rd.flushAllPending();
    this.rd.checkExitCode?.(exitCode);
    this.eb.emit({ type: "observation", run_id: this.runId, source: "output_pipe", summary: "exec complete", payload: { step_id: this.stepId, exit_code: exitCode } });
    this.ag.onExecComplete?.(this.stepId, exitCode, "exec");
  }

  async flush(): Promise<void> { await this.rd.flushAllPending(); }

  disableSilence(): void { if (this.silenceTimer) clearTimeout(this.silenceTimer); }

  private resetSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceAt = Date.now();
    this.silenceTimer = setTimeout(() => {
      const elapsed = Date.now() - this.silenceAt;
      const connected = this.conn?.state() === "connected";
      this.rd.checkSilence?.(connected, elapsed);
    }, this.silenceMs);
  }
}
