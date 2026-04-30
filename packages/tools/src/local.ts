import { execFile as cpExecFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { Connection, ExecResult } from "./connection.js";

const execFile = promisify(cpExecFile);

export interface SecurityPolicy {
  allowed_commands: string[];
  blocked_push_paths: string[];
}

const DEFAULT_POLICY: SecurityPolicy = {
  allowed_commands: [],
  blocked_push_paths: ["/etc", "/boot", "/System", "C:\\Windows"],
};

export class LocalConnection implements Connection {
  private policy: SecurityPolicy;

  constructor(policy?: Partial<SecurityPolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  state(): "connected" { return "connected"; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    // Security: whitelist enforcement — "*" allows all, empty list allows none
    const cmdName = cmd.split(/\s+/)[0] ?? "";
    if (!this.policy.allowed_commands.includes("*") && !this.policy.allowed_commands.includes(cmdName)) {
      return { stdout: "", stderr: `Command not allowed: ${cmdName}`, exit_code: 126 };
    }

    // Use execFile with argv — no shell interpolation
    const parts = cmd.split(/\s+/);
    const command = parts[0] ?? "true";
    const args = parts.slice(1);

    try {
      const { stdout, stderr } = await execFile(command, args, { timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, stderr, exit_code: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exit_code: err.code ?? (err.killed ? 124 : 1) };
    }
  }

  async push(src: string, dst: string): Promise<void> {
    // Security: check blocked push paths
    const normalized = path.normalize(dst);
    for (const blocked of this.policy.blocked_push_paths) {
      if (normalized.startsWith(blocked)) {
        throw new Error(`Push blocked: destination "${dst}" matches blocked path "${blocked}"`);
      }
    }
    await fs.copyFile(src, dst);
  }
}
