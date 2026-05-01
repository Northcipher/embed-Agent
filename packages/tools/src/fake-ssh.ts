/**
 * Fake SSH client for unit testing Ssh2Connection without a real SSH server.
 */
import type { SshClientLike } from "./ssh.js";

export interface FakeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class FakeSshClient implements SshClientLike {
  private readyListeners: Array<() => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];
  private closeListeners: Array<() => void> = [];
  private execHandlers: Array<(cmd: string) => FakeExecResult> = [];
  private queuedResults: FakeExecResult[] = [];
  private _connected = false;

  /** Pre-configure an exec handler that returns a fixed result for a specific command prefix. */
  mockExec(cmdPattern: string, result: FakeExecResult): void {
    this.execHandlers.push((cmd) => {
      if (cmd.startsWith(cmdPattern)) return result;
      // Return a distinct sentinel for non-matching commands
      return { exitCode: -1, stdout: "", stderr: "" };
    });
  }

  /** Queue a result for the next exec call, regardless of command. */
  queueExecResult(result: FakeExecResult): void { this.queuedResults.push(result); }

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "ready") this.readyListeners.push(listener as () => void);
    if (event === "error") this.errorListeners.push(listener as (err: Error) => void);
    if (event === "close") this.closeListeners.push(listener as () => void);
  }

  /** Set to true before connect() to test connection failure. */
  failNextConnect = false;
  /** Error to deliver when failNextConnect is true. */
  nextConnectError = new Error("Connection refused");

  connect(_config: Record<string, unknown>): void {
    this._connected = true;
    if (this.failNextConnect) {
      this.failNextConnect = false;
      const err = this.nextConnectError;
      setImmediate(() => { for (const l of this.errorListeners) l(err); });
      return;
    }
    setImmediate(() => { for (const l of this.readyListeners) l(); });
  }

  simulateError(err: Error): void {
    this._connected = false;
    for (const l of this.errorListeners) l(err);
  }

  simulateClose(): void {
    this._connected = false;
    for (const l of this.closeListeners) l();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec(command: string, _options: Record<string, unknown>, callback: (err: Error | undefined, stream: any) => void): void {
    if (!this._connected) {
      callback(new Error("Not connected"), undefined);
      return;
    }

    // Build a fake stream
    const listeners: Array<(data: Buffer) => void> = [];
    const closeListeners: Array<() => void> = [];
    const stderrListeners: Array<(data: Buffer) => void> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = {
      exitCode: null,
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "data") listeners.push(listener as (data: Buffer) => void);
        if (event === "close") closeListeners.push(listener as () => void);
      },
      stderr: {
        on(_event: string, listener: (...args: unknown[]) => void) {
          stderrListeners.push(listener as (data: Buffer) => void);
        },
      },
    };

    // Resolve result: queued > handler match > default echo
    let result: FakeExecResult;
    const queued = this.queuedResults.shift();
    if (queued) {
      result = queued;
    } else {
      // Match handlers by command prefix — only the matching handler fires
      const handler = this.execHandlers.find(h => {
        const probe = h(command);
        // exitCode -1 is the sentinel for "not my command"
        return probe.exitCode !== -1;
      });
      result = handler
        ? handler(command)
        : { exitCode: 0, stdout: `echo: ${command}`, stderr: "" };
    }

    // Feed result to stream asynchronously
    setImmediate(() => {
      callback(undefined, stream);
      stream.exitCode = result.exitCode;
      if (result.stdout) {
        for (const l of listeners) l(Buffer.from(result.stdout, "utf-8"));
      }
      if (result.stderr) {
        for (const l of stderrListeners) l(Buffer.from(result.stderr, "utf-8"));
      }
      for (const l of closeListeners) l();
    });
  }

  end(): void {
    this._connected = false;
    for (const l of this.closeListeners) l();
  }

  get connected(): boolean { return this._connected; }
}
