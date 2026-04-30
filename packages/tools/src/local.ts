import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Connection, ExecResult } from "./connection.js";

const execAsync = promisify(cpExec);

export class LocalConnection implements Connection {
  state(): "connected" { return "connected"; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, stderr, exit_code: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exit_code: err.code ?? (err.killed ? 124 : 1) };
    }
  }

  async push(src: string, dst: string): Promise<void> {
    await fs.copyFile(src, dst);
  }
}
