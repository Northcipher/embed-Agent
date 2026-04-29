import { describe, it, expect } from "vitest";
import { LocalConnection } from "../src/local-connection.js";

describe("LocalConnection", () => {
  it("should execute a simple command", async () => {
    const conn = new LocalConnection();
    const result = await conn.exec("echo hello", 5);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("should return non-zero exit code for failed command", async () => {
    const conn = new LocalConnection();
    const result = await conn.exec("exit 1", 5);
    expect(result.exit_code).toBe(1);
  });

  it("should always be connected", () => {
    const conn = new LocalConnection();
    expect(conn.state()).toBe("connected");
  });

  it("should handle timeout", async () => {
    const conn = new LocalConnection();
    const result = await conn.exec("sleep 10", 1);
    expect(result.exit_code).not.toBe(0);
  });
});
