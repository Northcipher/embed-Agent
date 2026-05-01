import { describe, it, expect } from "vitest";
import { Ssh2Connection } from "../src/ssh.js";
import { FakeSshClient } from "../src/fake-ssh.js";

function createFakeConnection() {
  const fake = new FakeSshClient();
  const conn = new Ssh2Connection(
    {
      host: "test-device.local",
      port: 22,
      username: "root",
      commandPolicy: {
        allowed_commands: ["uname", "dmesg", "cat", "echo"],
        blocked_patterns: ["rm -rf"],
        max_command_length: 4096,
      },
      hostKeyPolicy: { type: "skip" },
    },
    () => fake,
  );
  return { conn, fake };
}

describe("Ssh2Connection", () => {
  it("connects successfully with fake client", async () => {
    const { conn } = createFakeConnection();
    await conn.connect();
    expect(conn.state()).toBe("connected");
  });

  it("exec returns stdout for allowed command", async () => {
    const { conn, fake } = createFakeConnection();
    fake.mockExec("uname", { exitCode: 0, stdout: "Linux", stderr: "" });
    await conn.connect();
    const result = await conn.exec("uname -a", 5);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("Linux");
  });

  it("exec blocks disallowed commands", async () => {
    const { conn, fake } = createFakeConnection();
    await conn.connect();
    await expect(conn.exec("reboot", 5)).rejects.toThrow("blocked by policy");
  });

  it("exec blocks commands matching blocked patterns", async () => {
    const { conn, fake } = createFakeConnection();
    await conn.connect();
    await expect(conn.exec("rm -rf /", 5)).rejects.toThrow("blocked by policy");
  });

  it("auto-reconnects and executes when connection dropped", async () => {
    const { conn, fake } = createFakeConnection();
    fake.mockExec("uname", { exitCode: 0, stdout: "reconnected", stderr: "" });
    await conn.connect();
    // Simulate unexpected disconnect
    fake.simulateClose();
    expect(conn.state()).toBe("disconnected");
    // exec should auto-reconnect and succeed
    const r = await conn.exec("uname -a", 5);
    expect(r.stdout).toBe("reconnected");
    expect(conn.state()).toBe("connected");
  });

  it("connect rejects on client error", async () => {
    const { conn, fake } = createFakeConnection();
    fake.failNextConnect = true;
    fake.nextConnectError = new Error("Connection refused");
    await expect(conn.connect()).rejects.toThrow("Connection refused");
    expect(conn.state()).toBe("error");
  });

  it("disconnect transitions state", async () => {
    const { conn, fake } = createFakeConnection();
    await conn.connect();
    expect(conn.state()).toBe("connected");
    await conn.disconnect();
    expect(conn.state()).toBe("disconnected");
  });

  it("onDisconnect fires on close", async () => {
    const { conn, fake } = createFakeConnection();
    let fired = false;
    conn.onDisconnect = () => { fired = true; };
    await conn.connect();
    fake.simulateClose();
    expect(fired).toBe(true);
    expect(conn.state()).toBe("disconnected");
  });

  it("getRuntimeState returns correct state", async () => {
    const { conn, fake } = createFakeConnection();
    await conn.connect();
    const state = conn.getRuntimeState();
    expect(state.connected).toBe(true);
    expect(state.host).toBe("test-device.local");
    expect(state.port).toBe(22);
    expect(state.username).toBe("root");
  });

  it("queued exec results work", async () => {
    const { conn, fake } = createFakeConnection();
    fake.queueExecResult({ exitCode: 0, stdout: "first", stderr: "" });
    fake.queueExecResult({ exitCode: 1, stdout: "", stderr: "second failed" });
    await conn.connect();
    const r1 = await conn.exec("echo test1", 5);
    expect(r1.stdout).toBe("first");
    const r2 = await conn.exec("echo test2", 5);
    expect(r2.exit_code).toBe(1);
    expect(r2.stderr).toBe("second failed");
  });

  it("prefix match: 'cat' does not allow 'catastrophe'", async () => {
    const fake = new FakeSshClient();
    const conn = new Ssh2Connection(
      { host: "h", port: 22, commandPolicy: { allowed_commands: ["cat"], blocked_patterns: [], max_command_length: 4096 }, hostKeyPolicy: { type: "skip" } },
      () => fake,
    );
    fake.mockExec("cat", { exitCode: 0, stdout: "cat worked", stderr: "" });
    await conn.connect();
    const r1 = await conn.exec("cat /proc/version", 5);
    expect(r1.stdout).toBe("cat worked");
    await expect(conn.exec("catastrophe", 5)).rejects.toThrow("blocked by policy");
  });

  it("wildcard '*' allows all commands", async () => {
    const fake = new FakeSshClient();
    const conn = new Ssh2Connection(
      { host: "h", port: 22, commandPolicy: { allowed_commands: ["*"], blocked_patterns: ["rm -rf"], max_command_length: 4096 }, hostKeyPolicy: { type: "skip" } },
      () => fake,
    );
    fake.mockExec("anything", { exitCode: 0, stdout: "ok", stderr: "" });
    await conn.connect();
    const r = await conn.exec("anything goes", 5);
    expect(r.stdout).toBe("ok");
    await expect(conn.exec("rm -rf /", 5)).rejects.toThrow("blocked by policy");
  });

  it("blocks command exceeding max_command_length", async () => {
    const fake = new FakeSshClient();
    const conn = new Ssh2Connection(
      { host: "h", port: 22, commandPolicy: { allowed_commands: ["echo"], blocked_patterns: [], max_command_length: 10 }, hostKeyPolicy: { type: "skip" } },
      () => fake,
    );
    await conn.connect();
    await expect(conn.exec("echo hello world", 5)).rejects.toThrow("exceeds max length");
  });
});
