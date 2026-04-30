import type { Connection, ExecResult } from "./connection.js";

export class FakeConnection implements Connection {
  onDisconnect?: () => void;
  private _state: "connected" | "disconnected" | "error" = "connected";

  execResult: ExecResult = { stdout: "", stderr: "", exit_code: 0 };
  streamLines: string[] = [];
  flashShouldFail = false;
  delayMs = 0; // Simulate slow device for timeout/pause tests

  async connect(): Promise<void> { this._state = "connected"; }
  async disconnect(): Promise<void> { this._state = "disconnected"; }
  state() { return this._state; }

  async exec(): Promise<ExecResult> {
    if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
    return this.execResult;
  }

  async *stream(): AsyncIterable<string> {
    for (const line of this.streamLines) {
      if (this._state === "disconnected") break;
      yield line;
    }
  }

  async push(): Promise<void> {}
  async flash(): Promise<void> { if (this.flashShouldFail) throw new Error("flash failed"); }

  simulateDisconnect(): void { this._state = "disconnected"; this.onDisconnect?.(); }
}
