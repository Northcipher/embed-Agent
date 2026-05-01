import type { Connection } from "./connection.js";
import { LocalConnection, type SecurityPolicy } from "./local.js";
import { SerialConnection } from "./serial.js";
import { AdbConnection } from "./adb.js";
import { FastbootConnection } from "./fastboot.js";
import { Ssh2Connection } from "./ssh.js";

export type Transport = "serial" | "adb" | "fastboot" | "ssh" | "local";

interface Emitter {
  emit(e: Record<string, unknown>): void;
}

interface TargetStateReader {
  getState(targetId: string): Promise<{ state: string; serial: string; adb: string; fastboot: string; current_run_id?: string } | null>;
}

export class ConnectionManager {
  private pool = new Map<string, Connection>();
  private eb: Emitter | undefined;
  private targetState: TargetStateReader | undefined;
  private securityPolicy: Partial<SecurityPolicy> | undefined;
  private shellAllowed: Set<string> | undefined;

  constructor(eb?: Emitter, targetState?: TargetStateReader, securityPolicy?: Partial<SecurityPolicy>) {
    this.eb = eb;
    this.targetState = targetState;
    this.securityPolicy = securityPolicy;
    if (securityPolicy?.allowed_commands?.length) {
      this.shellAllowed = new Set(securityPolicy.allowed_commands);
    }
  }

  get(target: { target_id: string; connections: Record<string, unknown> }, transport: Transport): Connection | null {
    const key = `${target.target_id}:${transport}`;
    if (this.pool.has(key)) return this.pool.get(key)!;

    let conn: Connection | null = null;
    switch (transport) {
      case "local": conn = new LocalConnection(this.securityPolicy); break;
      case "serial": {
        const s = target.connections.serial as import("./serial.js").SerialConfig | undefined;
        if (s) conn = new SerialConnection(s);
        break;
      }
      case "adb": {
        const a = target.connections.adb as { device_id: string } | undefined;
        if (a) conn = new AdbConnection(a.device_id);
        break;
      }
      case "fastboot": {
        const f = target.connections.fastboot as { device_id: string } | undefined;
        if (f) conn = new FastbootConnection(f.device_id);
        break;
      }
      case "ssh": {
        const s = target.connections.ssh as import("./ssh-config.js").SshConnectionConfig | undefined;
        if (s) conn = new Ssh2Connection(s);
        break;
      }
    }

    if (conn) {
      this.pool.set(key, conn);
      this.wireDisconnect(target.target_id, transport, conn);
    }
    return conn;
  }

  getForStep(target: { target_id: string; connections: Record<string, unknown> }, action: string, capability: string): Connection | null {
    if (action === "stream") {
      if (capability === "adb_logs") return this.get(target, "adb");
      return this.get(target, "serial");
    }
    if (action === "flash") return this.get(target, "fastboot");
    if (action === "push") return this.get(target, "adb") ?? this.get(target, "ssh");
    if (capability === "wait_adb" || capability === "collect_logs") return this.get(target, "adb");
    if (capability === "ssh_exec") {
      return this.get(target, "ssh");
    }
    if (capability === "shell_exec") {
      // Require whitelist — reject if none configured
      if (!this.shellAllowed || this.shellAllowed.size === 0) return null;
      return this.get(target, "adb") ?? this.get(target, "ssh");
    }
    return this.get(target, "adb") ?? this.get(target, "ssh") ?? this.get(target, "local");
  }

  private wireDisconnect(targetId: string, transport: Transport, conn: Connection): void {
    if (!this.eb) return;
    const prev = conn.onDisconnect;
    conn.onDisconnect = async () => {
      prev?.();
      // Look up full runtime state for complete TargetStateChanged payload
      let runtimeState: { serial: string; adb: string; fastboot: string; current_run_id?: string } | undefined;
      try { runtimeState = await this.targetState?.getState(targetId) ?? undefined; } catch { /* best effort */ }

      // Update the disconnected transport in the state
      if (runtimeState) {
        if (transport === "serial") runtimeState.serial = "disconnected";
        if (transport === "adb") runtimeState.adb = "offline";
        if (transport === "fastboot") runtimeState.fastboot = "disconnected";
      }

      this.eb!.emit({
        type: "target_state_changed",
        run_id: runtimeState?.current_run_id,
        source: "connection_manager",
        summary: `${transport} disconnected for target ${targetId}`,
        payload: {
          target_id: targetId,
          transport,
          state: "disconnected",
          serial: runtimeState?.serial ?? "unknown",
          adb: runtimeState?.adb ?? "unknown",
          fastboot: runtimeState?.fastboot ?? "unknown",
          current_run_id: runtimeState?.current_run_id,
        },
      });
      // Remove from pool so next get() reconnects
      this.pool.delete(`${targetId}:${transport}`);
    };
  }
}
