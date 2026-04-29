import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { Connection } from "@embed-agent/contracts";

export interface SerialConfig {
  port: string;
  baudRate: number;
}

export class SerialConnection implements Connection {
  onDisconnect?: () => void;
  private config: SerialConfig;
  private port: SerialPort | null = null;
  private _state: "connected" | "disconnected" | "error" = "disconnected";

  constructor(config: SerialConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.port = new SerialPort({
      path: this.config.port,
      baudRate: this.config.baudRate,
      autoOpen: false,
    });
    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => {
        if (err) reject(err);
        else { this._state = "connected"; resolve(); }
      });
    });
    this.port.on("close", () => {
      this._state = "disconnected";
      this.onDisconnect?.();
    });
    this.port.on("error", () => {
      this._state = "error";
      this.onDisconnect?.();
    });
  }

  async disconnect(): Promise<void> {
    if (!this.port?.isOpen) return;
    await new Promise<void>((resolve) => {
      this.port!.close(() => { this._state = "disconnected"; resolve(); });
    });
  }

  state(): "connected" | "disconnected" | "error" {
    return this._state;
  }

  async *stream(timeout: number): AsyncIterable<string> {
    if (!this.port?.isOpen) return;
    const parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
    const endTime = Date.now() + timeout * 1000;

    for await (const line of parser) {
      if (this._state === "disconnected") break;
      if (Date.now() > endTime) break;
      yield line;
    }
  }
}
