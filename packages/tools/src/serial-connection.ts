import type { Connection } from "@embed-agent/contracts";

export interface SerialConfig {
  port: string;
  baudRate: number;
}

// SerialConnection uses the `serialport` npm package.
// Implementation deferred until serialport is installed.
// Interface contract: open port → stream lines → detect disconnect.
export class SerialConnection implements Connection {
  onDisconnect?: (callback: () => void) => void;
  private config: SerialConfig;
  private port: unknown = null;

  constructor(config: SerialConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // TODO: import SerialPort from 'serialport'
    // this.port = new SerialPort({ path: this.config.port, baudRate: this.config.baudRate, autoOpen: false });
    // await this.port.open();
    // this.port.on('close', () => this._onDisconnect?.());
    // this.port.on('error', () => this._onDisconnect?.());
  }

  async disconnect(): Promise<void> {
    // TODO: await this.port?.close();
  }

  state(): "connected" | "disconnected" | "error" {
    // TODO: return this.port?.isOpen ? "connected" : "disconnected";
    return "disconnected";
  }

  async *stream(_timeout: number): AsyncIterable<string> {
    // TODO: ReadlineParser on port → yield lines until timeout or interrupt
    yield "";
  }
}
