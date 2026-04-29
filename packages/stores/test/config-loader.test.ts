import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ConfigLoader } from "../src/config-loader.js";

describe("ConfigLoader", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-cfg-${Date.now()}`);
  const loader = new ConfigLoader(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should load and validate a target profile", async () => {
    const targetDir = path.join(tmpDir, "targets", "board-01");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "profile.json"), JSON.stringify({
      target_id: "board-01", connections: {},
      safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
    }));

    const profile = await loader.loadTargetProfile("board-01");
    expect(profile.target_id).toBe("board-01");
  });

  it("should reject invalid target profile", async () => {
    const targetDir = path.join(tmpDir, "targets", "board-02");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "profile.json"), JSON.stringify({
      target_id: "board-02",
      // missing safety
    }));

    await expect(loader.loadTargetProfile("board-02")).rejects.toThrow("Config validation failed");
  });

  it("should load hooks config with empty default", async () => {
    const cfg = await loader.loadHookConfig();
    expect(cfg.hooks).toEqual([]);
  });
});
