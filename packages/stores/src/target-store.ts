import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic.js";
import { validateId } from "./validate.js";

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
  private dataRoot: string;
  /** Per-target mutex for read-modify-write serialization. */
  private locks = new Map<string, Promise<void>>();

  constructor(dataRoot = ".embed-agent") {
    this.dataRoot = dataRoot;
  }

  private dir(targetId: string): string {
    validateId(targetId, "targetId");
    return path.join(this.dataRoot, "targets", targetId);
  }

  /** Serialize mutations per target to prevent lost updates under concurrency. */
  private serialized(targetId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(targetId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(targetId, next);
    return next;
  }

  async add(profile: TargetProfile): Promise<void> {
    await writeAtomic(path.join(this.dir(profile.target_id), "profile.json"), JSON.stringify(profile, null, 2));
    const initState: TargetRuntimeState = {
      target_id: profile.target_id, state: "idle",
      serial: "disconnected", adb: "disconnected", fastboot: "disconnected",
      updated_at: new Date().toISOString(),
    };
    await this.writeState(profile.target_id, initState);
  }

  async get(targetId: string): Promise<TargetProfile | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir(targetId), "profile.json"), "utf-8")) as TargetProfile; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async getState(targetId: string): Promise<TargetRuntimeState | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir(targetId), "runtime-state.json"), "utf-8")) as TargetRuntimeState; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async updateState(targetId: string, patch: Partial<TargetRuntimeState>): Promise<void> {
    await this.serialized(targetId, async () => {
      const current = await this.getState(targetId);
      if (!current) throw new Error(`Target not found: ${targetId}`);
      const updated = { ...current, ...patch, target_id: targetId, updated_at: new Date().toISOString() };
      await this.writeState(targetId, updated as TargetRuntimeState);
    });
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
    await writeAtomic(path.join(this.dir(targetId), "runtime-state.json"), JSON.stringify(state, null, 2));
  }
}
