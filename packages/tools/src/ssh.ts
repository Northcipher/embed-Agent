import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { readFile } from "node:fs/promises";
import type { Connection, ExecResult } from "./connection.js";
import type { SshConnectionConfig, SshRuntimeState, HostKeyFingerprint } from "./ssh-config.js";
import { DEFAULT_SSH_COMMAND_POLICY } from "./ssh-config.js";

/** Minimal SSH client interface — real Client or fake for testing. */
export interface SshClientLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  connect(config: Record<string, unknown>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec(command: string, options: Record<string, unknown>, callback: (err: Error | undefined, stream: any) => void): void;
  end(): void;
}

/** Wraps ssh2 Client in our SshClientLike interface. */
export class RealSsh2Client implements SshClientLike {
  constructor(private client: Client) {}
  on(event: string, listener: (...args: unknown[]) => void): void { this.client.on(event as never, listener as never); }
  connect(config: Record<string, unknown>): void { this.client.connect(config as ConnectConfig); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec(command: string, options: Record<string, unknown>, callback: (err: Error | undefined, stream: any) => void): void {
    this.client.exec(command, options as never, (err, stream) => callback(err ?? undefined, stream));
  }
  end(): void { this.client.end(); }
}

export class Ssh2Connection implements Connection {
  onDisconnect?: () => void;
  private client: SshClientLike | null = null;
  private _state: "connected" | "disconnected" | "error" = "disconnected";
  private config: SshConnectionConfig;
  private lastError?: string;
  private lastHandshakeAt?: string;
  /** Host key fingerprint from the most recent handshake. */
  private lastHostKeyHash?: string;

  constructor(config: SshConnectionConfig, clientFactory?: () => SshClientLike) {
    this.config = config;
    // Allow injection of fake client for testing
    if (clientFactory) {
      this.client = clientFactory();
    } else {
      this.client = new RealSsh2Client(new Client());
    }
  }

  // --- Connection lifecycle ---

  async connect(): Promise<void> {
    if (!this.client) {
      this.client = new RealSsh2Client(new Client());
    }

    const policy = this.config.commandPolicy ?? DEFAULT_SSH_COMMAND_POLICY;

    // Validate command policy at connect time
    if (policy.allowed_commands.length === 0 && !this.config.hostKeyPolicy) {
      // Allow-none + no host key policy = effectively disarmed. Warn but don't block.
    }

    const connectConfig = await this.buildConnectConfig();

    return new Promise<void>((resolve, reject) => {
      this.client!.on("ready", () => {
        this._state = "connected";
        this.lastHandshakeAt = new Date().toISOString();
        this.lastError = undefined as unknown as string;
        resolve();
      });

      this.client!.on("error", (err: unknown) => {
        const msg = (err as Error).message ?? String(err);
        this._state = "error";
        this.lastError = msg;
        reject(new Error(`SSH connection to ${this.config.host}:${this.config.port} failed: ${msg}`));
      });

      this.client!.on("close", () => {
        const wasConnected = this._state === "connected";
        this._state = "disconnected";
        if (wasConnected) this.onDisconnect?.();
      });

      this.client!.connect(connectConfig as unknown as Record<string, unknown>);
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this._state = "disconnected";
  }

  state(): "connected" | "disconnected" | "error" {
    return this._state;
  }

  // --- exec ---

  async exec(cmd: string, timeout: number): Promise<ExecResult> {
    // Auto-reconnect on transient drop (network idle timeout, server restart)
    if (!this.client || this._state !== "connected") {
      if (this._state === "disconnected" || this._state === "error") {
        try { await this.connect(); } catch { throw new Error("SSH not connected"); }
      } else {
        throw new Error("SSH not connected");
      }
    }
    const policy = this.config.commandPolicy ?? DEFAULT_SSH_COMMAND_POLICY;
    if (cmd.length > policy.max_command_length) {
      throw new Error(`SSH command exceeds max length ${policy.max_command_length}: ${cmd.length} chars`);
    }
    if (!this.isCommandAllowed(cmd)) {
      throw new Error(`SSH command blocked by policy: ${cmd.slice(0, 80)}`);
    }

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client!.exec(cmd, { timeout: timeout * 1000 }, (err: Error | undefined, stream: any) => {
        if (err) {
          this.lastError = err.message;
          reject(new Error(`SSH exec failed: ${err.message}`));
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString("utf-8");
        });

        if (stream.stderr) {
          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf-8");
          });
        }

        stream.on("close", () => {
          resolve({
            // Use actual exit code when available; only infer failure from stderr when exitCode is null
            exit_code: stream.exitCode != null ? stream.exitCode : (stderr.length > 0 ? 1 : 0),
            stdout,
            stderr,
          });
        });
      });
    });
  }

  // --- push (via SFTP) ---

  async push(_src: string, _dst: string): Promise<void> {
    // SFTP push requires sftp subsystem — defer to scp for now
    throw new Error("SSH push via SFTP not yet implemented. Use scp command via exec.");
  }

  // --- Runtime state ---

  getRuntimeState(): SshRuntimeState {
    const s: SshRuntimeState = {
      connected: this._state === "connected",
      host: this.config.host,
      port: this.config.port,
    };
    if (this.config.username) s.username = this.config.username;
    if (this.lastHandshakeAt) s.lastHandshakeAt = this.lastHandshakeAt;
    if (this.lastError) s.lastError = this.lastError;
    return s;
  }

  /** Get the host key fingerprint from the last connection (if available). */
  getLastHostKey(): HostKeyFingerprint | undefined {
    if (!this.lastHostKeyHash) return undefined;
    return {
      hash: this.lastHostKeyHash,
      algorithm: "sha256",
      keyType: "ssh-ed25519",
      host: this.config.host,
      port: this.config.port,
    };
  }

  // --- Private ---

  private isCommandAllowed(cmd: string): boolean {
    const policy = this.config.commandPolicy ?? DEFAULT_SSH_COMMAND_POLICY;
    if (policy.allowed_commands.length === 0) return false;
    if (policy.allowed_commands.includes("*")) return !this.matchesBlockedPattern(cmd, policy);
    // Prefix match with word boundary: "cat" matches "cat file" but not "catastrophe"
    return policy.allowed_commands.some(a => {
      if (cmd === a) return true;
      if (cmd.startsWith(a + " ")) return true;
      return false;
    }) && !this.matchesBlockedPattern(cmd, policy);
  }

  private matchesBlockedPattern(cmd: string, policy: { blocked_patterns: string[] }): boolean {
    return policy.blocked_patterns.some(p => cmd.includes(p));
  }

  private async buildConnectConfig(): Promise<ConnectConfig> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {
      host: this.config.host,
      port: this.config.port,
      readyTimeout: this.config.readyTimeoutMs ?? 15000,
      keepaliveInterval: this.config.keepaliveIntervalMs ?? 30000,
      keepaliveCountMax: 3,
    };
    if (this.config.username) cfg.username = this.config.username;
    if (this.config.password) cfg.password = this.config.password;

    // Private key: prefer keyPath, then inline key
    if (this.config.privateKeyPath) {
      cfg.privateKey = await readFile(this.config.privateKeyPath, "utf-8");
    } else if (this.config.privateKey) {
      cfg.privateKey = this.config.privateKey;
    }
    if (this.config.passphrase) {
      cfg.passphrase = this.config.passphrase;
    }

    // Host key verifier
    const hkp = this.config.hostKeyPolicy ?? { type: "accept-new" };
    const hostPort = `${this.config.host}:${this.config.port}`;
    switch (hkp.type) {
      case "skip":
        cfg.hostVerifier = () => true;
        break;
      case "trust-on-first-use": {
        // Accept any key on first connect, then pin it
        const knownKey = this.lastHostKeyHash;
        cfg.hostVerifier = (hashedKey: string) => {
          if (!knownKey) {
            this.lastHostKeyHash = hashedKey;
            return true;
          }
          return knownKey === hashedKey;
        };
        break;
      }
      case "accept-new": {
        // Accept known keys + new keys, but warn on key change
        const knownKey = this.lastHostKeyHash;
        cfg.hostVerifier = (hashedKey: string) => {
          if (!knownKey) {
            this.lastHostKeyHash = hashedKey;
            return true;
          }
          if (knownKey !== hashedKey) {
            console.warn(`[Ssh2Connection] Host key changed for ${hostPort}! Possible MITM. Accepting anyway (accept-new policy).`);
            this.lastHostKeyHash = hashedKey;
          }
          return true;
        };
        break;
      }
      case "strict":
        cfg.hostVerifier = (hashedKey: string) => {
          const expected = hkp.knownHosts[hostPort];
          return expected === hashedKey;
        };
        break;
    }

    // Try keyboard-interactive as fallback
    cfg.tryKeyboard = true;

    return cfg;
  }
}
