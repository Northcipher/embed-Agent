import type { Connection } from "./connection.js";
import { LocalConnection } from "./local.js";
import { SerialConnection } from "./serial.js";
import { AdbConnection } from "./adb.js";
import { FastbootConnection } from "./fastboot.js";

export type Transport = "serial" | "adb" | "fastboot" | "ssh" | "local";

export class ConnectionManager {
  private pool = new Map<string, Connection>();

  get(target: { target_id: string; connections: Record<string, unknown> }, transport: Transport): Connection | null {
    const key = `${target.target_id}:${transport}`;
    if (this.pool.has(key)) return this.pool.get(key)!;

    let conn: Connection | null = null;
    switch (transport) {
      case "local": conn = new LocalConnection(); break;
      case "serial": {
        const s = target.connections.serial as { port: string; baud: number } | undefined;
        if (s) conn = new SerialConnection({ port: s.port, baudRate: s.baud });
        break;
      }
      case "adb": {
        const a = target.connections.adb as { device_id: string } | undefined;
        if (a) conn = new AdbConnection(a.device_id);
        break;
      }
      case "fastboot": {
        const f = target.connections.fastboot as { device_id: string } | undefined;
        conn = new FastbootConnection(f?.device_id);
        break;
      }
    }

    if (conn) this.pool.set(key, conn);
    return conn;
  }

  getForStep(target: { target_id: string; connections: Record<string, unknown> }, action: string, capability: string): Connection | null {
    if (action === "stream") return this.get(target, "serial");
    if (action === "flash") return this.get(target, "fastboot");
    if (action === "push") return this.get(target, "adb") ?? this.get(target, "ssh");
    if (capability === "wait_adb" || capability === "collect_logs") return this.get(target, "adb");
    if (capability === "shell_exec") return this.get(target, "adb") ?? this.get(target, "ssh");
    return this.get(target, "adb") ?? this.get(target, "ssh") ?? this.get(target, "local");
  }
}
