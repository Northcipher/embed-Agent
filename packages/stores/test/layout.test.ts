import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getRunDir, getTargetDir, getMemoryDir, getEventsPath, initLayout } from "../src/layout.js";

describe("Layout", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-test-${Date.now()}`);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("initLayout should create all directories", async () => {
    await initLayout(tmpDir);
    const stat = await fs.stat(path.join(tmpDir, "runs"));
    expect(stat.isDirectory()).toBe(true);
    const memStat = await fs.stat(path.join(tmpDir, "memory", "working-memory"));
    expect(memStat.isDirectory()).toBe(true);
  });

  it("getRunDir should return correct path", () => {
    expect(getRunDir("/data", "run-001")).toBe("/data/runs/run-001");
  });

  it("getTargetDir should return correct path", () => {
    expect(getTargetDir("/data")).toBe("/data/targets");
  });

  it("getMemoryDir should return correct path", () => {
    expect(getMemoryDir("/data")).toBe("/data/memory");
  });

  it("getEventsPath should return global events path", () => {
    expect(getEventsPath("/data")).toBe("/data/events.jsonl");
  });
});
