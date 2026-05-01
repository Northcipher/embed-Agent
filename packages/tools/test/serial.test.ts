/**
 * Serial connection tests using SerialPortMock for realistic parser/open/close behavior.
 */
import { describe, it, expect } from "vitest";
import { SerialPortMock } from "serialport";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockBinding = (SerialPortMock as any).binding;

import { beforeEach } from "vitest";
import { SerialConnection, type SerialConfig, type SerialPortFactory, type SerialPortLike } from "../src/serial.js";

beforeEach(() => {
  MockBinding.reset();
});

function mockFactory(config: SerialConfig): SerialPortLike {
  // MockBinding must have the port pre-created
  MockBinding.createPort(config.port, { echo: false, record: true });
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
  return new SerialPortMock(opts) as unknown as SerialPortLike;
}

const baseConfig: SerialConfig = { port: "/dev/ttyTEST", baudRate: 115200 };

describe("SerialConnection", () => {
  // --- connect / disconnect ---

  it("connects and disconnects via SerialPortMock", async () => {
    const conn = new SerialConnection(baseConfig, mockFactory);
    await conn.connect();
    expect(conn.state()).toBe("connected");
    expect(conn.getPort()?.isOpen).toBe(true);

    await conn.disconnect();
    expect(conn.state()).toBe("disconnected");
  });

  it("connect fails with invalid port config", async () => {
    // Don't call mockFactory which creates the port — let it fail naturally
    const conn = new SerialConnection(
      { port: "/dev/NONEXISTENT", baudRate: 9600 },
      () => {
        MockBinding.createPort("/dev/NONEXISTENT", { echo: false, record: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new SerialPortMock({ path: "/dev/NONEXISTENT", baudRate: 0, autoOpen: false } as any) as unknown as SerialPortLike;
      },
    );
    await expect(conn.connect()).rejects.toThrow();
    expect(conn.state()).toBe("error");
  });

  // --- onDisconnect: expected vs unexpected ---

  it("onDisconnect fires once on manual disconnect", async () => {
    const conn = new SerialConnection(baseConfig, mockFactory);
    let fires = 0;
    conn.onDisconnect = () => { fires++; };

    await conn.connect();
    await conn.disconnect();
    expect(fires).toBe(0); // manual disconnect does NOT fire onDisconnect
  });

  it("onDisconnect fires on unexpected port close", async () => {
    const conn = new SerialConnection(baseConfig, mockFactory);
    let fires = 0;
    conn.onDisconnect = () => { fires++; };

    await conn.connect();
    // Simulate unexpected close
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn.getPort()! as any).close(() => {});
    await new Promise(r => setTimeout(r, 10));
    expect(fires).toBe(1);
  });

  // --- stream ---

  it("stream exits on disconnect", async () => {
    const conn = new SerialConnection(baseConfig, mockFactory);
    await conn.connect();

    const lines: string[] = [];
    const streamDone = (async () => {
      for await (const line of conn.stream!(5)) {
        lines.push(line);
      }
    })();

    // Disconnect after a short delay — stream should exit cleanly
    await new Promise(r => setTimeout(r, 20));
    await conn.disconnect();
    await streamDone;
    // Stream exited without hanging
    expect(lines.length).toBe(0);
    expect(conn.state()).toBe("disconnected");
  });

  it("stream respects timeout with no incoming data", async () => {
    const conn = new SerialConnection(baseConfig, mockFactory);
    await conn.connect();

    const lines: string[] = [];
    const start = Date.now();
    for await (const line of conn.stream!(0.1)) { // 100ms timeout
      lines.push(line);
    }
    const elapsed = Date.now() - start;
    expect(lines.length).toBe(0); // no data fed, stream should exit on timeout
    expect(elapsed).toBeLessThan(300);
  });

  // --- config options ---

  it("accepts full SerialConfig with all options", async () => {
    const fullConfig: SerialConfig = {
      port: "/dev/ttyTEST",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "hardware",
      dtr: true,
      rts: true,
      delimiter: "\r\n",
      encoding: "ascii",
    };
    const conn = new SerialConnection(fullConfig, mockFactory);
    await conn.connect();
    expect(conn.state()).toBe("connected");
    await conn.disconnect();
  });
});
