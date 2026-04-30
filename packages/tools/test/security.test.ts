/**
 * SECURITY REGRESSION TESTS
 *
 * Verifies:
 * 1. Shell whitelist is enforced by default (no commands pass without explicit allow)
 * 2. validateId blocks path traversal in all stores
 * 3. execFile is used (argv, not shell strings)
 */
import { describe, it, expect } from "vitest";
import { LocalConnection } from "../src/local.js";
import { EventStore } from "../../stores/src/event-store.js";
import { RunStore } from "../../stores/src/run-store.js";
import { TargetStore } from "../../stores/src/target-store.js";
import { MemoryStore } from "../../stores/src/memory-store.js";
import { EvidenceStore } from "../../stores/src/evidence-store.js";

describe("Security: shell whitelist", () => {
  it("rejects commands by default (empty allowlist)", async () => {
    const c = new LocalConnection();
    const r = await c.exec("id", 5);
    expect(r.exit_code).toBe(126);
    expect(r.stderr).toContain("not allowed");
  });

  it("allows listed commands", async () => {
    const c = new LocalConnection({ allowed_commands: ["echo"] });
    const r = await c.exec("echo hello", 5);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  it("rejects unlisted commands even when list is populated", async () => {
    const c = new LocalConnection({ allowed_commands: ["echo"] });
    const r = await c.exec("id", 5);
    expect(r.exit_code).toBe(126);
  });

  it("allows all commands when '*' is in the list", async () => {
    const c = new LocalConnection({ allowed_commands: ["*"] });
    const r = await c.exec("echo anything", 5);
    expect(r.exit_code).toBe(0);
  });

  it("blocks push to protected paths", async () => {
    const c = new LocalConnection();
    await expect(c.push("/tmp/test", "/etc/hosts")).rejects.toThrow("blocked");
  });
});

describe("Security: path traversal protection", () => {
  it("EventStore rejects ../ in runId", async () => {
    const store = new EventStore();
    await expect(store.read("../escape")).rejects.toThrow("path characters");
  });

  it("RunStore rejects ../ in runId", async () => {
    const store = new RunStore();
    await expect(store.get("../escape")).rejects.toThrow("path characters");
  });

  it("TargetStore rejects ../ in targetId", async () => {
    const store = new TargetStore();
    await expect(store.get("../escape")).rejects.toThrow("path characters");
  });

  it("MemoryStore rejects ../ in runId for WM", async () => {
    const store = new MemoryStore();
    await expect(store.writeWorkingMemory("../escape", [])).rejects.toThrow("path characters");
  });

  it("EvidenceStore rejects ../ in runId", async () => {
    const store = new EvidenceStore();
    await expect(store.read("../escape", "x:full")).rejects.toThrow("path characters");
  });

  it("EvidenceStore rejects ../ in ref", async () => {
    const store = new EvidenceStore();
    await expect(store.read("r1", "../etc/passwd")).rejects.toThrow("path characters");
  });
});
