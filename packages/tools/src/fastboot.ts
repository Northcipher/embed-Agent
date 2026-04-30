import { execFile as cpExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection, ExecResult } from "./connection.js";

const execFile = promisify(cpExecFile);

export class FastbootConnection implements Connection {
  onDisconnect?: () => void;
  private _connected = false;

  constructor(private deviceId?: string) {}

  private get fastbootArgs(): string[] {
    return this.deviceId ? ["-s", this.deviceId] : [];
  }

  async connect(): Promise<void> {
    try {
      const { stdout } = await execFile("fastboot", [...this.fastbootArgs, "devices"], { timeout: 10000 });
      this._connected = stdout.trim().length > 0;
      if (!this._connected) throw new Error("No fastboot devices found");
    } catch (e) {
      this._connected = false;
      throw e;
    }
  }
  async disconnect(): Promise<void> { this._connected = false; }
  state() { return this._connected ? "connected" : "disconnected"; }

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    try {
      const args = [...this.fastbootArgs, ...cmd.split(" ")];
      const { stdout, stderr } = await execFile("fastboot", args, { timeout: timeout * 1000 });
      return { stdout, stderr, exit_code: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exit_code: err.code ?? 1 };
    }
  }

  async flash(image: string, partition: string): Promise<void> {
    await execFile("fastboot", [...this.fastbootArgs, "flash", partition, image], { timeout: 300000 });
  }
}
