import { describe, it, expect } from "vitest";
import { FakeConnection } from "../src/fake-connection.js";

describe("FakeConnection", () => {
  it("should return configured exec result", async () => {
    const conn = new FakeConnection();
    conn.execResult = { stdout: "hello", stderr: "", exit_code: 0 };
    const r = await conn.exec!("test", 5);
    expect(r.stdout).toBe("hello");
  });

  it("should stream configured lines", async () => {
    const conn = new FakeConnection();
    conn.streamLines = ["line1", "line2", "line3"];
    const lines: string[] = [];
    for await (const line of conn.stream!(10)) {
      lines.push(line);
    }
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("should simulate disconnect", () => {
    const conn = new FakeConnection();
    conn.simulateDisconnect();
    expect(conn.state()).toBe("disconnected");
  });

  it("should fire onDisconnect callback", () => {
    const conn = new FakeConnection();
    let fired = false;
    conn.onDisconnect = () => { fired = true; };
    conn.simulateDisconnect();
    expect(fired).toBe(true);
  });
});
