import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TargetStore } from "../src/target-store.js";
import type { TargetProfile, TargetRuntimeState } from "@embed-agent/contracts";

const minimalProfile: TargetProfile = {
  target_id: "board-01", connections: {},
  safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
};

describe("TargetStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-ts-${Date.now()}`);
  const store = new TargetStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should add and retrieve a target profile", async () => {
    await store.add(minimalProfile);
    const profile = await store.get("board-01");
    expect(profile).not.toBeNull();
    expect(profile!.target_id).toBe("board-01");
  });

  it("should initialize runtime state on add", async () => {
    const state = await store.getState("board-01");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("idle");
  });

  it("should update runtime state", async () => {
    await store.updateState("board-01", { state: "busy", current_run_id: "run-001" });
    const state = await store.getState("board-01");
    expect(state!.state).toBe("busy");
    expect(state!.current_run_id).toBe("run-001");
  });

  it("should list all profiles", async () => {
    await store.add({ ...minimalProfile, target_id: "board-02" });
    const profiles = await store.listAll();
    expect(profiles.length).toBeGreaterThanOrEqual(2);
  });

  it("should list all states", async () => {
    const states = await store.listStates();
    expect(states.length).toBeGreaterThanOrEqual(2);
  });

  it("should remove a target", async () => {
    await store.remove("board-02");
    const profile = await store.get("board-02");
    expect(profile).toBeNull();
  });
});
