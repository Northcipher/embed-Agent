import fs from "node:fs/promises";
import type { ConnectionManager, Transport } from "./connection-manager.js";

interface TargetStore {
  get(id: string): Promise<{ target_id: string; connections: Record<string, unknown>; recovery?: { reboot_method?: string; stable_artifact?: string } } | null>;
  getState(id: string): Promise<{ state: string; current_run_id?: string } | null>;
  updateState(id: string, p: Record<string, unknown>): Promise<void>;
}

interface PreflightCheck { check: string; passed: boolean; error?: string; }

export class TargetManager {
  constructor(private cm: ConnectionManager, private store: TargetStore) {}

  async preflight(targetId: string, transports: Transport[], artifactPath: string): Promise<{ all_passed: boolean; checks: PreflightCheck[]; failure_type?: "host" | "device" }> {
    const target = await this.store.get(targetId);
    if (!target) return { all_passed: false, checks: [{ check: "target_exists", passed: false, error: "not found" }], failure_type: "host" };

    const checks: PreflightCheck[] = [];
    for (const t of transports) {
      const conn = this.cm.get(target, t);
      if (!conn) { checks.push({ check: `${t}_available`, passed: false, error: "not configured" }); continue; }
      try { await conn.connect(); checks.push({ check: `${t}_open`, passed: true }); }
      catch (e) { checks.push({ check: `${t}_open`, passed: false, error: (e as Error).message }); }
    }

    // Use fs.access, not shell exec
    try { await fs.access(artifactPath); checks.push({ check: "artifact_exists", passed: true }); }
    catch { checks.push({ check: "artifact_exists", passed: false }); }

    const failed = checks.filter(c => !c.passed);
    const failureType = failed.some(c => c.check.includes("serial") || c.check.includes("adb") || c.check.includes("fastboot")) ? "device" : "host";
    return { all_passed: failed.length === 0, checks, failure_type: failureType };
  }

  async recover(targetId: string): Promise<boolean> {
    const t = await this.store.get(targetId);
    if (!t) return false;
    const method = t.recovery?.reboot_method ?? "adb";
    if (method === "custom_command") return false;

    try {
      const conn = this.cm.get(t, method as Transport);
      if (conn?.exec) await conn.exec("reboot", 30);
    } catch { return false; }

    return true;
  }

  isBusy(state: { state: string } | null): boolean {
    return state != null && !["idle", "offline"].includes(state.state);
  }
}
