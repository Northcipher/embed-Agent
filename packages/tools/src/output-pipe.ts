// Minimal interfaces for dependency injection
interface OutputEventEmitter {
  emit(event: Record<string, unknown>): void;
}

interface RingBufferInput {
  push(line: string): void;
  totalPushed(): number;
}

export class OutputPipe {
  private lineBuffer = "";
  private batchCounter = 0;
  private _silenceTimerActive = true;

  constructor(
    private evidenceWriter: { append(data: string): void },
    private ringBuffer: RingBufferInput,
    private ruleDetector: { detect(line: string, lineIndex: number): void; checkExitCode?(code: number): void },
    private aggregator: { feed(line: string): void; onExecComplete?(stepId: string): void },
    private eventBus: OutputEventEmitter,
    private stepId: string,
    private silenceTimeoutMs = 60000,
  ) {}

  feedStream(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      this.evidenceWriter.append(line + "\n");
      this.ringBuffer.push(line);
      this.ruleDetector.detect(line, this.ringBuffer.totalPushed() - 1);
      this.aggregator.feed(line);
    }

    this.batchCounter += lines.length;
    if (this.batchCounter >= 100) {
      this.eventBus.emit({ type: "observation", lines: this.batchCounter });
      this.batchCounter = 0;
    }

    if (this._silenceTimerActive && lines.length > 0) {
      this.resetSilenceTimer();
    }
  }

  feedExec(stdout: string, stderr: string, exitCode: number): void {
    const combined = stdout + "\n" + stderr;
    const lines = combined.split("\n").filter(l => l.length > 0);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      this.evidenceWriter.append(line + "\n");
      this.ringBuffer.push(line);
      this.ruleDetector.detect(line, this.ringBuffer.totalPushed() - 1);
      this.aggregator.feed(line);
    }

    this.ruleDetector.checkExitCode?.(exitCode);
    this.eventBus.emit({ type: "observation" });
    this.aggregator.onExecComplete?.(this.stepId);
  }

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.eventBus.emit({ type: "rule_matched", rule_id: "serial_silence", severity: "warning" });
    }, this.silenceTimeoutMs);
  }

  disableSilenceTimer(): void {
    this._silenceTimerActive = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
  }
}
