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
}
