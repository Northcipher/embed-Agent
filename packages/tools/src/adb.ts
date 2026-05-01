/**
 * ADB connection — device I/O via Android Debug Bridge.
 * Uses injectable AdbClient so unit tests can run without a real device.
 * Pattern borrowed from appium-adb's injectable executable config.
 */
import type { Connection, ExecResult } from "./connection.js";
import type { AdbClient } from "./adb-client.js";
import { RealAdbClient, AdbError, classifyAdbError, adbErrorHint } from "./adb-client.js";

export class AdbConnection implements Connection {
  onDisconnect?: () => void;
  private _state: "connected" | "disconnected" | "error" = "disconnected";
  private lastError?: string;

  constructor(
    private deviceId: string,
    private client: AdbClient = new RealAdbClient(),
  ) {}

  // --- Connection lifecycle ---

  async connect(): Promise<void> {
    try {
      const r = await this.client.run(["-s", this.deviceId, "get-state"], 10000);
      const state = r.stdout.trim();
      if (state !== "device") {
        // Classify directly from known state strings first
        const knownStates: Record<string, import("./adb-client.js").AdbDeviceState> = {
          "offline": "offline",
          "unauthorized": "unauthorized",
        };
        const deviceState = knownStates[state] ?? classifyAdbError(r.stderr, r.exit_code);
        const hint = adbErrorHint(deviceState, this.deviceId);
        this._state = "error";
        this.lastError = hint;
        throw new Error(hint);
      }
      this._state = "connected";
      delete this.lastError;
    } catch (e) {
      this._state = "error";
      if (e instanceof AdbError) {
        this.lastError = e.message;
        throw e;
      }
      // e might already be our own Error from above
      const msg = (e as Error).message;
      this.lastError = msg;
      throw new Error(`Failed to connect ADB device "${this.deviceId}": ${msg}`);
    }
  }

  async disconnect(): Promise<void> {
    this._state = "disconnected";
  }

  state(): "connected" | "disconnected" | "error" {
    return this._state;
  }

  // --- exec ---

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    if (cmd === "wait_adb") return this.waitForDevice(timeout);

    try {
      const r = await this.client.run(["-s", this.deviceId, "shell", cmd], timeout * 1000);
      return { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code };
    } catch (e) {
      if (e instanceof AdbError) {
        return { stdout: "", stderr: e.rawOutput ?? e.message, exit_code: 1 };
      }
      const msg = (e as Error).message;
      return { stdout: "", stderr: msg, exit_code: 1 };
    }
  }

  // --- stream ---

  stream(timeout: number): AsyncIterable<string> {
    if (!this.client.stream) {
      throw new Error("ADB streaming not supported by this client");
    }
    const args = ["-s", this.deviceId, "logcat", "-v", "threadtime"];
    const source = this.client.stream(args, timeout * 1000);
    const deadline = Date.now() + timeout * 1000;
    // Wrap to enforce timeout at connection level too
    return (async function*() {
      for await (const line of source) {
        if (Date.now() > deadline) break;
        yield line;
      }
    })();
  }

  // --- push ---

  async push(src: string, dst: string): Promise<void> {
    try {
      await this.client.run(["-s", this.deviceId, "push", src, dst], 60000);
    } catch (e) {
      if (e instanceof AdbError) throw e;
      throw new Error(`ADB push failed for ${this.deviceId}: ${src} -> ${dst}: ${(e as Error).message}`);
    }
  }

  // --- wait-for-device ---

  private async waitForDevice(timeoutSec: number): Promise<ExecResult> {
    const deadline = Date.now() + timeoutSec * 1000;
    let lastError = "";

    // First: explicit wait-for-device
    try {
      await this.client.run(["-s", this.deviceId, "wait-for-device"], Math.min(timeoutSec * 1000, 30000));
    } catch {
      // wait-for-device may fail quickly; fall through to polling
    }

    // Poll get-state until device is ready or timeout
    while (Date.now() < deadline) {
      try {
        const r = await this.client.run(["-s", this.deviceId, "get-state"], 5000);
        if (r.stdout.trim() === "device") {
          return { stdout: "device", stderr: "", exit_code: 0 };
        }
        lastError = `state is "${r.stdout.trim()}", expected "device"`;
      } catch (e) {
        lastError = (e as Error).message;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    return {
      stdout: "",
      stderr: `ADB wait-for-device timeout (${timeoutSec}s) for ${this.deviceId}. Last error: ${lastError}`,
      exit_code: 1,
    };
  }

  /** Expose the last connection error for diagnostics. */
  getLastError(): string | undefined {
    return this.lastError;
  }
}
