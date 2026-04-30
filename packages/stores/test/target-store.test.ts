import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TargetStore, type TargetProfile } from "../src/target-store.js";

const p: TargetProfile = { target_id: "b1", connections: {}, safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false } };

describe("TargetStore", () => {
  const d = path.join(os.tmpdir(), `ts-${Date.now()}`);
  const s = new TargetStore(d);
  afterAll(async () => { await fs.rm(d, { recursive: true, force: true }); });

  it("add initializes state", async () => {
    await s.add(p);
    const st = await s.getState("b1");
    expect(st!.state).toBe("idle");
  });

  it("updateState", async () => {
    await s.updateState("b1", { state: "busy", current_run_id: "r1" });
    expect((await s.getState("b1"))!.state).toBe("busy");
  });

  it("listAll + listStates", async () => {
    await s.add({ ...p, target_id: "b2" });
    expect((await s.listAll()).length).toBeGreaterThanOrEqual(2);
    expect((await s.listStates()).length).toBeGreaterThanOrEqual(2);
  });

  it("remove", async () => {
    await s.remove("b2");
    expect(await s.get("b2")).toBeNull();
  });
});
