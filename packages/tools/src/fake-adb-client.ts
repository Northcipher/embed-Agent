/**
 * Fake ADB client for unit testing AdbConnection without a real device.
 * Pattern: injectable AdbClient interface, test fake with scripted responses.
 */
import type { AdbClient, AdbExecResult } from "./adb-client.js";
import { AdbError, type AdbDeviceState } from "./adb-client.js";

export interface FakeAdbRule {
  /** Match args by exact join or prefix. */
  argsPattern: string;
  /** Result to return when matched. */
  result: AdbExecResult;
  /** Optional delay to simulate latency. */
  delayMs?: number;
}

export class FakeAdbClient implements AdbClient {
  private rules: FakeAdbRule[] = [];
  private calls: Array<{ args: string[]; timeoutMs: number }> = [];

  /** Add a scripted response for a specific command pattern. */
  on(pattern: string, result: AdbExecResult, delayMs?: number): void {
    const rule: FakeAdbRule = { argsPattern: pattern, result };
    if (delayMs != null) rule.delayMs = delayMs;
    this.rules.push(rule);
  }

  /** Return all recorded calls for assertion. */
  getCalls(): Array<{ args: string[]; timeoutMs: number }> {
    return this.calls;
  }

  /** Clear calls and rules. */
  reset(): void { this.rules = []; this.calls = []; }

  async run(args: string[], timeoutMs: number): Promise<AdbExecResult> {
    this.calls.push({ args, timeoutMs });
    const joined = args.join(" ");

    // Find matching rule
    const rule = this.rules.find(r => joined.startsWith(r.argsPattern));
    if (!rule) {
      throw new AdbError(`No fake rule matched: adb ${joined}`, "unknown");
    }

    if (rule.delayMs) {
      await new Promise(r => setTimeout(r, rule.delayMs));
    }

    return rule.result;
  }

  // --- Convenience helpers for common device states ---

  /** Simulate a device that connects successfully. */
  configureOnline(deviceId: string): void {
    this.on(`-s ${deviceId} get-state`, { stdout: "device\n", stderr: "", exit_code: 0 });
    this.on(`-s ${deviceId} wait-for-device`, { stdout: "", stderr: "", exit_code: 0 });
  }

  /** Simulate a device that is offline. */
  configureOffline(deviceId: string): void {
    this.on(`-s ${deviceId} get-state`, { stdout: "offline\n", stderr: "", exit_code: 0 });
  }

  /** Simulate an unauthorized device. */
  configureUnauthorized(deviceId: string): void {
    this.on(`-s ${deviceId} get-state`, { stdout: "unauthorized\n", stderr: "", exit_code: 0 });
  }

  /** Simulate a device that appears after N retries (for wait-for-device polling). */
  configureWaitForDevice(deviceId: string, readyAfterRetries: number): void {
    // Remove old get-state rules
    this.rules = this.rules.filter(r => !r.argsPattern.includes("get-state"));
    // Queue: N offline results, then a device result
    const queue: AdbExecResult[] = [];
    for (let i = 0; i < readyAfterRetries; i++) {
      queue.push({ stdout: "offline\n", stderr: "", exit_code: 0 });
    }
    queue.push({ stdout: "device\n", stderr: "", exit_code: 0 });
    let idx = 0;
    // Single rule that drains the queue
    this.on(`-s ${deviceId} get-state`, {
      get stdout() { const r = queue[Math.min(idx, queue.length - 1)]!; idx++; return r.stdout; },
      stderr: "",
      exit_code: 0,
    });
  }

  // --- Stream support ---

  private streamLines: Map<string, string[]> = new Map();

  /** Configure lines to yield for a given stream args pattern. */
  configureStream(pattern: string, lines: string[]): void {
    this.streamLines.set(pattern, lines);
  }

  async *stream(args: string[], _timeoutMs: number): AsyncIterable<string> {
    const key = args.join(" ");
    const lines = this.streamLines.get(key);
    if (lines) {
      for (const line of lines) {
        // Simulate line-delivery latency so timeout has a chance to fire
        await new Promise(r => setTimeout(r, 1));
        yield line;
      }
    }
  }

  /** Simulate a shell command response. */
  configureShell(deviceId: string, command: string, result: AdbExecResult): void {
    this.on(`-s ${deviceId} shell ${command}`, result);
  }

  /** Simulate push success/failure. */
  configurePush(deviceId: string, src: string, dst: string, shouldSucceed: boolean): void {
    if (shouldSucceed) {
      this.on(`-s ${deviceId} push ${src} ${dst}`, { stdout: "", stderr: "", exit_code: 0 });
    } else {
      // Will throw since no rule matches — simulate by registering a failing rule
      this.rules.push({
        argsPattern: `-s ${deviceId} push ${src} ${dst}`,
        result: { stdout: "", stderr: "", exit_code: 0 },
      });
    }
  }

  /** Simulate a device-not-found error. */
  configureNotFoundError(deviceId: string): void {
    this.on(`-s ${deviceId} get-state`, {
      stdout: "",
      stderr: "error: device '"+ deviceId +"' not found\n",
      exit_code: 1,
    });
  }
}
