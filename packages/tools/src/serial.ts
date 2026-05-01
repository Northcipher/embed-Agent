/**
 * Serial connection — embedded device I/O via serial port.
 * Uses node-serialport. Supports SerialPortMock for testing without hardware.
 */
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { Connection } from "./connection.js";

export interface SerialConfig {
  /** Path to the serial device (e.g. /dev/ttyUSB0 or /dev/serial/by-id/...) */
  port: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  parity?: "none" | "even" | "odd" | "mark" | "space";
  stopBits?: 1 | 1.5 | 2;
  /** Line delimiter for stream parsing. Default: "\n". */
  delimiter?: string;
  /** Encoding for data. Default: "utf8". */
  encoding?: BufferEncoding;
  /** Flow control: hardware (RTS/CTS) or software (XON/XOFF). */
  flowControl?: "none" | "hardware" | "software";
  /** Enable RTS/CTS hardware flow control. Shorthand for flowControl: "hardware". */
  rtscts?: boolean;
  /** Set DTR (Data Terminal Ready) on open. Default: true. */
  dtr?: boolean;
  /** Set RTS (Request To Send) on open. Default: true. */
  rts?: boolean;
}

/** SerialPort compatible constructor — real or mock. */
export interface SerialPortLike {
  isOpen: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipe<T>(dest: T): T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void;
  open(cb: (err?: Error | null) => void): void;
  close(cb: (err?: Error | null) => void): void;
  set?(props: Record<string, unknown>, cb?: (err?: Error | null) => void): void;
}

/** Factory to create a SerialPort — injectable for testing. */
export type SerialPortFactory = (config: SerialConfig) => SerialPortLike;

/** Default factory: creates a real serialport SerialPort. */
export function createRealSerialPort(config: SerialConfig): SerialPortLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = {
    path: config.port,
    baudRate: config.baudRate,
    autoOpen: false,
  };
  if (config.dataBits != null) opts.dataBits = config.dataBits;
  if (config.parity != null) opts.parity = config.parity;
  if (config.stopBits != null) opts.stopBits = config.stopBits;
  if (config.rtscts != null) opts.rtscts = config.rtscts;
  if (config.dtr != null) opts.dtr = config.dtr;
  if (config.rts != null) opts.rts = config.rts;
  // flowControl maps to rtscts + xon/xoff in serialport
  if (config.flowControl === "hardware") opts.rtscts = true;
  else if (config.flowControl === "software") { opts.xon = true; opts.xoff = true; }
  return new SerialPort(opts) as unknown as SerialPortLike;
}

export class SerialConnection implements Connection {
  onDisconnect?: () => void;
  private port: SerialPortLike | null = null;
  private _state: "connected" | "disconnected" | "error" = "disconnected";
  private closedByUs = false;
  private disconnectNotifier: (() => void) | null = null;

  constructor(
    private config: SerialConfig,
    private portFactory: SerialPortFactory = createRealSerialPort,
  ) {}

  // --- Connection lifecycle ---

  async connect(): Promise<void> {
    this.closedByUs = false;
    this.port = this.portFactory(this.config);

    await new Promise<void>((resolve, reject) => {
      this.port!.open(err => {
        if (err) { this._state = "error"; reject(err); return; }
        this._state = "connected";
        resolve();
      });
    });

    this.port.on("close", () => {
      const wasUnexpected = !this.closedByUs;
      this._state = "disconnected";

      if (wasUnexpected) {
        this.onDisconnect?.();
      }
    });

    this.port.on("error", () => {
      this._state = "error";
    });
  }

  async disconnect(): Promise<void> {
    this.closedByUs = true;
    // Unblock any pending stream reads
    this.disconnectNotifier?.();
    this.disconnectNotifier = null;
    if (!this.port?.isOpen) return;
    await new Promise<void>(resolve =>
      this.port!.close(() => { this._state = "disconnected"; resolve(); })
    );
  }

  state(): "connected" | "disconnected" | "error" {
    return this._state;
  }

  // --- stream ---

  async *stream(timeout: number): AsyncIterable<string> {
    if (!this.port?.isOpen) return;

    const parser = this.port.pipe(new ReadlineParser({
      delimiter: this.config.delimiter ?? "\n",
      encoding: this.config.encoding ?? "utf8",
    }));

    const deadline = Date.now() + timeout * 1000;

    // Race: parser data vs timeout vs disconnect signal
    type StreamResult = { done: false; value: string } | { done: true };
    const nextLine = (): Promise<StreamResult> => new Promise((resolve) => {
      const onData = (line: unknown) => { cleanup(); resolve({ done: false, value: line as string }); };
      const onClose = () => { cleanup(); resolve({ done: true }); };
      const cleanup = () => { parser.removeListener("data", onData); parser.off("close", onClose); };
      parser.once("data", onData);
      parser.on("close", onClose);
    });

    try {
      while (Date.now() < deadline && this._state !== "disconnected") {
        const remaining = Math.max(50, deadline - Date.now());
        const result = await Promise.race([
          nextLine(),
          new Promise<{ done: true }>(r => setTimeout(() => r({ done: true }), remaining)),
          new Promise<{ done: true }>(r => { this.disconnectNotifier = () => r({ done: true }); }),
        ]);
        if (result.done) break;
        yield result.value;
      }
    } finally {
      this.disconnectNotifier = null;
      if (!parser.destroyed) parser.destroy();
    }
  }

  /** Expose the underlying port for test inspection. */
  getPort(): SerialPortLike | null { return this.port; }
}
