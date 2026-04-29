import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "@embed-agent/contracts";

function makeTask(id: string, name: string): Task {
  return {
    task_id: id, name,
    trigger: { type: "cron", cron: "0 2 * * *" },
    skill: "validate-boot", params: {},
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("TaskStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-tsk-${Date.now()}`);
  const store = new TaskStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create and list tasks", async () => {
    await store.create(makeTask("t1", "nightly-boot"));
    const tasks = await store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("nightly-boot");
  });

  it("should get task by id", async () => {
    const task = await store.get("t1");
    expect(task).not.toBeNull();
  });

  it("should update task", async () => {
    await store.update("t1", { enabled: false });
    const task = await store.get("t1");
    expect(task!.enabled).toBe(false);
  });

  it("should delete task", async () => {
    await store.delete("t1");
    const tasks = await store.list();
    expect(tasks).toHaveLength(0);
  });
});
