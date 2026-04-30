import fs from "node:fs/promises";
import path from "node:path";

export type TargetState = "idle" | "preparing" | "busy" | "cleaning" | "dirty" | "recovery" | "offline";

export interface TargetProfile {
  target_id: string;
  display_name?: string;
  connections: Record<string, unknown>;
  flash?: { method: string; artifact_type: string };
  recovery?: { reboot_method?: string; stable_artifact?: string };
  safety: { allow_flash: boolean; allow_reboot: boolean; allow_shell_exec: boolean; allow_power_cycle: boolean };
  target_hints?: Record<string, unknown>;
  skills?: string[];
}

export interface TargetRuntimeState {
  target_id: string;
  state: TargetState;
  current_run_id?: string;
  serial: "connected" | "disconnected";
  adb: "online" | "offline" | "disconnected";
  fastboot: "connected" | "disconnected";
  last_heartbeat_at?: string;
  updated_at: string;
}

export class TargetStore {
  constructor(private dataRoot = ".embed-agent") {}

  private dir(targetId: string): string {
    return path.join(this.dataRoot, "targets", targetId);
  }

  async add(profile: TargetProfile): Promise<void> {
    await fs.mkdir(this.dir(profile.target_id), { recursive: true });
    await fs.writeFile(path.join(this.dir(profile.target_id), "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
    const initState: TargetRuntimeState = {
      target_id: profile.target_id, state: "idle",
      serial: "disconnected", adb: "disconnected", fastboot: "disconnected",
      updated_at: new Date().toISOString(),
    };
    await this.writeState(profile.target_id, initState);
  }

  async get(targetId: string): Promise<TargetProfile | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir(targetId), "profile.json"), "utf-8")) as TargetProfile; }
    catch { return null; }
  }

  async getState(targetId: string): Promise<TargetRuntimeState | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir(targetId), "runtime-state.json"), "utf-8")) as TargetRuntimeState; }
    catch { return null; }
  }

  async updateState(targetId: string, patch: Partial<TargetRuntimeState>): Promise<void> {
    const current = await this.getState(targetId);
    const updated = { ...current, ...patch, target_id: targetId, updated_at: new Date().toISOString() };
    await this.writeState(targetId, updated as TargetRuntimeState);
  }

  async listAll(): Promise<TargetProfile[]> {
    const dir = path.join(this.dataRoot, "targets");
    try {
      const profiles: TargetProfile[] = [];
      for (const e of await fs.readdir(dir)) {
        const p = await this.get(e);
        if (p) profiles.push(p);
      }
      return profiles;
    } catch { return []; }
  }

  async listStates(): Promise<TargetRuntimeState[]> {
    const dir = path.join(this.dataRoot, "targets");
    try {
      const states: TargetRuntimeState[] = [];
      for (const e of await fs.readdir(dir)) {
        const s = await this.getState(e);
        if (s) states.push(s);
      }
      return states;
    } catch { return []; }
  }

  async remove(targetId: string): Promise<void> {
    await fs.rm(this.dir(targetId), { recursive: true, force: true });
  }

  private async writeState(targetId: string, state: TargetRuntimeState): Promise<void> {
    const file = path.join(this.dir(targetId), "runtime-state.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), "utf-8");
  }
}
