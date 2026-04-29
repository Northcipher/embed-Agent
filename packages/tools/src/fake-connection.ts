import type { Connection, ExecResult } from "@embed-agent/contracts";

export class FakeConnection implements Connection {
  private _state: "connected" | "disconnected" | "error" = "connected";
  onDisconnect?: () => void;

  // Configurable outputs
  execResult: ExecResult = { stdout: "", stderr: "", exit_code: 0 };
  streamLines: string[] = [];
  flashShouldFail = false;

  async connect(): Promise<void> { this._state = "connected"; }
  async disconnect(): Promise<void> { this._state = "disconnected"; }
  state(): "connected" | "disconnected" | "error" { return this._state; }

  async exec(_cmd: string, _timeout: number): Promise<ExecResult> {
    return this.execResult;
  }

  async *stream(_timeout: number): AsyncIterable<string> {
    for (const line of this.streamLines) {
      if (this._state === "disconnected") break;
      yield line;
    }
  }

  async push(_src: string, _dst: string): Promise<void> {}
  async flash(_image: string, _partition: string): Promise<void> {
    if (this.flashShouldFail) throw new Error("flash failed");
  }

  simulateDisconnect(): void {
    this._state = "disconnected";
    this.onDisconnect?.();
  }
}
