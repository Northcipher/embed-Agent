import fs from "node:fs/promises";
import type { ConnectionManager, Transport } from "./connection-manager.js";

interface TargetStore {
  get(id: string): Promise<{ target_id: string; connections: Record<string, unknown>; recovery?: { reboot_method?: string; stable_artifact?: string } } | null>;
  getState(id: string): Promise<{ state: string; current_run_id?: string } | null>;
  updateState(id: string, p: Record<string, unknown>): Promise<void>;
  listAll?(): Promise<{ target_id: string; connections: Record<string, unknown> }[]>;
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

    // 1. Reflash stable artifact via fastboot (independent of reboot method)
    if (t.recovery?.stable_artifact) {
      const fbConn = this.cm.get(t, "fastboot");
      if (fbConn?.flash) {
        try {
          const parts = t.recovery.stable_artifact.split(":");
          const image = parts[0];
          const partition = parts[1];
          if (image && partition) {
            await fbConn.flash(image, partition);
          } else {
            console.warn(`[TargetManager] Invalid stable_artifact format "${t.recovery.stable_artifact}" — expected "image:partition"`);
          }
        } catch (e) {
          console.warn(`[TargetManager] Recovery flash failed for ${t.target_id}: ${(e as Error).message}`);
        }
      }
    }

    // 2. Reboot via configured method
    const rebootConn = this.cm.get(t, method as Transport);
    if (!rebootConn?.exec) return false;
    try {
      const result = await rebootConn.exec("reboot", 30);
      if (result.exit_code !== 0) return false;
    } catch { return false; }

    // 3. Wait for device — verify via ADB, then Serial
    const deadline = Date.now() + 120_000;
    let delay = 3000;

    // Poll ADB first (primary verification)
    const adbConn = this.cm.get(t, "adb");
    if (adbConn) {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 15_000);
        try {
          await adbConn.connect();
          if (adbConn.state() === "connected") {
            // Also try serial verification
            const serialConn = this.cm.get(t, "serial");
            if (serialConn) {
              try { await serialConn.connect(); } catch { /* best effort */ }
            }
            return true;
          }
        } catch { /* still booting */ }
      }
    }

    // Fallback: poll the reboot transport if ADB not available
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15_000);
      try {
        await rebootConn.connect();
        if (rebootConn.state() === "connected") return true;
      } catch { /* still booting */ }
    }

    return false;
  }

  isBusy(state: { state: string } | null): boolean {
    return state != null && !["idle", "offline"].includes(state.state);
  }

  /** Acquire a target lock — transitions state to preparing with the given run_id. */
  async acquireLock(targetId: string, runId: string): Promise<boolean> {
    const s = await this.store.getState(targetId);
    if (this.isBusy(s)) return false;
    await this.store.updateState(targetId, { state: "preparing", current_run_id: runId });
    return true;
  }

  /** Release a target lock — transitions to cleaning then idle. */
  async releaseLock(targetId: string): Promise<void> {
    await this.store.updateState(targetId, { state: "cleaning" });
    // Small delay for cleanup, then idle
    await this.store.updateState(targetId, { state: "idle", current_run_id: undefined });
  }

  /** Transition target to a specific state. */
  async transitionState(targetId: string, to: string): Promise<void> {
    await this.store.updateState(targetId, { state: to });
  }

  /** Reconnect all known targets — used during startup recovery. */
  async reconnectAll(): Promise<void> {
    const profiles = await this.store.listAll?.() ?? [];
    for (const p of profiles) {
      const transports = Object.keys(p.connections ?? {}) as Transport[];
      for (const t of transports) {
        const conn = this.cm.get(p, t);
        if (conn) {
          try { await conn.connect(); } catch { /* best effort */ }
        }
      }
    }
  }
}
