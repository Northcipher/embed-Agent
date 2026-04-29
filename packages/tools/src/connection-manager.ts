import type { Connection, TargetProfile } from "@embed-agent/contracts";
import { LocalConnection } from "./local-connection.js";
import { SerialConnection } from "./serial-connection.js";
import { AdbConnection } from "./adb-connection.js";
import { FastbootConnection } from "./fastboot-connection.js";

export type TransportType = "serial" | "adb" | "fastboot" | "ssh" | "local";

export class ConnectionManager {
  private pool: Map<string, Connection> = new Map();

  getConnection(target: TargetProfile, transport: TransportType): Connection | null {
    const key = `${target.target_id}:${transport}`;
    if (this.pool.has(key)) return this.pool.get(key)!;

    let conn: Connection | null = null;
    switch (transport) {
      case "local":
        conn = new LocalConnection();
        break;
      case "serial":
        if (target.connections.serial) {
          conn = new SerialConnection({
            port: target.connections.serial.port,
            baudRate: target.connections.serial.baud,
          });
        }
        break;
      case "adb":
        if (target.connections.adb) {
          conn = new AdbConnection(target.connections.adb.device_id);
        }
        break;
      case "fastboot":
        conn = new FastbootConnection(target.connections.fastboot?.device_id);
        break;
    }

    if (conn) {
      this.pool.set(key, conn);
    }
    return conn;
  }

  releaseConnection(targetId: string, transport: TransportType): void {
    this.pool.delete(`${targetId}:${transport}`);
  }

  // Step-aware routing: action + capability → transport
  getConnectionForStep(target: TargetProfile, action: string, capability: string): Connection | null {
    switch (action) {
      case "stream": return this.getConnection(target, "serial");
      case "flash": return this.getConnection(target, "fastboot");
      case "push": return this.getConnection(target, "adb") ?? this.getConnection(target, "ssh");
      case "exec":
        if (capability === "wait_adb") return this.getConnection(target, "adb");
        if (capability === "collect_logs") return this.getConnection(target, "adb");
        if (capability === "shell_exec") return this.getConnection(target, "adb") ?? this.getConnection(target, "ssh");
        return this.getConnection(target, "adb") ?? this.getConnection(target, "ssh") ?? this.getConnection(target, "local");
      default:
        return this.getConnection(target, "local");
    }
  }
}
