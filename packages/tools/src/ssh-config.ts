/**
 * SSH connection config contract.
 * Host key policy and per-connection options live here so Runtime doesn't
 * need to know about ssh2 internals.
 */

/** Host key verification policy. */
export type HostKeyPolicy =
  | { type: "accept-new"; knownHostsPath?: string }      // accept on first connect, verify thereafter
  | { type: "strict"; knownHosts: Record<string, string> } // exact fingerprint match required
  | { type: "trust-on-first-use" }                         // accept any key once, then pin
  | { type: "skip" };                                      // no verification (insecure)

/** Host key fingerprint from a connection handshake. */
export interface HostKeyFingerprint {
  hash: string;
  algorithm: string;   // e.g. "sha256"
  keyType: string;     // e.g. "ssh-ed25519"
  host: string;
  port: number;
}

/** Remote command allowlist entry. */
export interface SshCommandPolicy {
  /** Shell commands allowed on the remote (e.g. ["uname", "dmesg", "cat /proc/*"]). Empty = allow-none. "*" = allow-all. */
  allowed_commands: string[];
  /** Block commands matching these patterns (checked after allow). */
  blocked_patterns: string[];
  /** Max command length in chars. */
  max_command_length: number;
}

export const DEFAULT_SSH_COMMAND_POLICY: SshCommandPolicy = {
  allowed_commands: [],
  blocked_patterns: ["rm -rf", "dd if=", "mkfs", ":(){ :|:& };:"],
  max_command_length: 4096,
};

/** SSH connection configuration for a target. */
export interface SshConnectionConfig {
  host: string;
  port: number;
  username?: string;
  /** Password for password-based authentication. */
  password?: string;
  /** Private key as string or path to key file. */
  privateKey?: string;
  /** Path to private key file. Takes precedence over privateKey inline string. */
  privateKeyPath?: string;
  /** Passphrase for encrypted private key. */
  passphrase?: string;
  /** Host key verification policy. Default: "accept-new". */
  hostKeyPolicy?: HostKeyPolicy;
  /** Command allowlist policy. Default: allow-none. */
  commandPolicy?: SshCommandPolicy;
  /** SSH-level keepalive interval in ms. 0 disables. Default: 30000. */
  keepaliveIntervalMs?: number;
  /** Handshake timeout in ms. Default: 15000. */
  readyTimeoutMs?: number;
}

/** Runtime state snapshot of an SSH connection. */
export interface SshRuntimeState {
  connected: boolean;
  host: string;
  port: number;
  username?: string;
  lastHandshakeAt?: string;
  lastError?: string;
}
