import fs from "node:fs/promises";
import path from "node:path";
import { getTargetDir } from "./layout.js";
import type { TargetProfile, TargetRuntimeState } from "@embed-agent/contracts";

export class TargetStore {
  constructor(private dataRoot: string) {}

  private profileFile(targetId: string): string {
    return path.join(getTargetDir(this.dataRoot), targetId, "profile.yml");
  }

  private stateFile(targetId: string): string {
    return path.join(getTargetDir(this.dataRoot), targetId, "runtime-state.json");
  }

  async get(targetId: string): Promise<TargetProfile | null> {
    try {
      const content = await fs.readFile(this.profileFile(targetId), "utf-8");
      // Simple YAML → JSON for P0 (YAML is 1:1 with JSON for our use case)
      // For now, store as JSON and read as JSON.
      return JSON.parse(content) as TargetProfile;
    } catch {
      return null;
    }
  }

  async getState(targetId: string): Promise<TargetRuntimeState | null> {
    try {
      const content = await fs.readFile(this.stateFile(targetId), "utf-8");
      return JSON.parse(content) as TargetRuntimeState;
    } catch {
      return null;
    }
  }

  async updateState(targetId: string, patch: Partial<TargetRuntimeState>): Promise<void> {
    const current = await this.getState(targetId);
    const updated = { ...current, ...patch, target_id: targetId, updated_at: new Date().toISOString() } as TargetRuntimeState;
    const dir = path.dirname(this.stateFile(targetId));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.stateFile(targetId), JSON.stringify(updated, null, 2), "utf-8");
  }

  async listAll(): Promise<TargetProfile[]> {
    const dir = getTargetDir(this.dataRoot);
    const profiles: TargetProfile[] = [];
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        const profile = await this.get(entry);
        if (profile) profiles.push(profile);
      }
    } catch {
      // no targets yet
    }
    return profiles;
  }

  async listStates(): Promise<TargetRuntimeState[]> {
    const dir = getTargetDir(this.dataRoot);
    const states: TargetRuntimeState[] = [];
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        const state = await this.getState(entry);
        if (state) states.push(state);
      }
    } catch {
      // no targets yet
    }
    return states;
  }

  async add(profile: TargetProfile): Promise<void> {
    const dir = path.dirname(this.profileFile(profile.target_id));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.profileFile(profile.target_id), JSON.stringify(profile, null, 2), "utf-8");
    // Initialize runtime state
    await this.updateState(profile.target_id, {
      state: "idle",
      serial: "disconnected",
      adb: "disconnected",
      fastboot: "disconnected",
    } as Partial<TargetRuntimeState>);
  }

  async remove(targetId: string): Promise<void> {
    const dir = path.dirname(this.profileFile(targetId));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
