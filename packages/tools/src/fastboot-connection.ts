import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import type { Connection, ExecResult } from "@embed-agent/contracts";

const execAsync = promisify(cpExec);

export class FastbootConnection implements Connection {
  private deviceId?: string;
  private _connected = false;
  private _onDisconnect?: () => void;

  constructor(deviceId?: string) {
    this.deviceId = deviceId;
  }

  get onDisconnect(): (() => void) | undefined { return this._onDisconnect; }
  set onDisconnect(cb: (() => void) | undefined) { this._onDisconnect = cb; }

  async connect(): Promise<void> {
    try {
      const cmd = this.deviceId
        ? `fastboot -s ${this.deviceId} devices`
        : "fastboot devices";
      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      this._connected = stdout.trim().length > 0;
    } catch {
      this._connected = false;
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  state(): "connected" | "disconnected" | "error" {
    return this._connected ? "connected" : "disconnected";
  }

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    const fullCmd = this.deviceId
      ? `fastboot -s ${this.deviceId} ${cmd}`
      : `fastboot ${cmd}`;
    try {
      const { stdout, stderr } = await execAsync(fullCmd, { timeout: timeout * 1000 });
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

  async flash(image: string, partition: string): Promise<void> {
    const fullCmd = this.deviceId
      ? `fastboot -s ${this.deviceId} flash ${partition} ${image}`
      : `fastboot flash ${partition} ${image}`;
    const { stderr } = await execAsync(fullCmd, { timeout: 300000 });
    if (stderr && !stderr.includes("OKAY")) {
      throw new Error(`fastboot flash failed: ${stderr}`);
    }
  }
}
