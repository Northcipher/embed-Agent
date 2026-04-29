import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import type { Connection, ExecResult } from "@embed-agent/contracts";

const execAsync = promisify(cpExec);

export class AdbConnection implements Connection {
  onDisconnect?: (callback: () => void) => void;
  private deviceId: string;
  private _connected = false;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  async connect(): Promise<void> {
    const { stdout } = await execAsync(`adb -s ${this.deviceId} get-state`, { timeout: 10000 });
    if (stdout.trim() === "device") {
      this._connected = true;
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  state(): "connected" | "disconnected" | "error" {
    return this._connected ? "connected" : "disconnected";
  }

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    // Special handling for wait_adb
    if (cmd === "wait_adb") {
      return this.waitForDevice(timeout);
    }

    const fullCmd = `adb -s ${this.deviceId} shell ${cmd}`;
    try {
      const { stdout, stderr } = await execAsync(fullCmd, {
        timeout: timeout * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr, exit_code: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exit_code: err.code ?? 1,
      };
    }
  }

  async push(src: string, dst: string): Promise<void> {
    await execAsync(`adb -s ${this.deviceId} push ${src} ${dst}`, { timeout: 60000 });
  }

  private async waitForDevice(timeoutSec: number): Promise<ExecResult> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execAsync(`adb -s ${this.deviceId} get-state`, { timeout: 5000 });
        if (stdout.trim() === "device") {
          return { stdout: "device", stderr: "", exit_code: 0 };
        }
      } catch {
        // device not ready yet
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return { stdout: "", stderr: "timeout waiting for device", exit_code: 1 };
  }
}
