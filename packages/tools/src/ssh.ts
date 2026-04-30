import type { Connection, ExecResult } from "./connection.js";

export class SshConnection implements Connection {
  onDisconnect?: () => void;
  private _connected = false;

  constructor(private host: string, private port = 22, private username?: string) {}

  async connect(): Promise<void> {
    // SSH connection requires ssh2 package — not yet implemented
    throw new Error(`SSH connection to ${this.host}:${this.port} not implemented. Install ssh2 package to enable.`);
  }
  async disconnect(): Promise<void> { this._connected = false; }
  state(): "connected" | "disconnected" | "error" { return this._connected ? "connected" : "disconnected"; }

  async exec(cmd: string, _timeout: number): Promise<ExecResult> {
    throw new Error("SSH exec not implemented");
  }

  async push(_src: string, _dst: string): Promise<void> {
    throw new Error("SSH push not implemented");
  }
}
