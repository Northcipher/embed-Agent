import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../src/skill-store.js";
import type { Skill } from "@embed-agent/contracts";

const bootSkill: Skill = {
  name: "validate-boot", description: "Validate boot", category: "boot",
  params: [], steps: [], evidence: { always: [], on_failure: [] },
  success: [], failure: [],
};

describe("SkillStore", () => {
  const tmpDir = path.join(os.tmpdir(), `embed-agent-sk-${Date.now()}`);
  const store = new SkillStore(tmpDir);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should save and load a skill", async () => {
    await store.save("validate-boot", bootSkill);
    const skill = await store.load("validate-boot");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("validate-boot");
  });

  it("should return null for unknown skill", async () => {
    const skill = await store.load("unknown");
    expect(skill).toBeNull();
  });

  it("should list all skills", async () => {
    await store.save("network-check", { ...bootSkill, name: "network-check", category: "network" });
    const skills = await store.loadAll();
    expect(skills.length).toBeGreaterThanOrEqual(2);
  });

  it("should load skills from custom dir", async () => {
    const customDir = path.join(tmpDir, "skills", "custom");
    await fs.mkdir(customDir, { recursive: true });
    await fs.writeFile(path.join(customDir, "custom-skill.json"), JSON.stringify({ ...bootSkill, name: "custom-skill" }));
    const skill = await store.load("custom-skill");
    expect(skill).not.toBeNull();
  });
});
