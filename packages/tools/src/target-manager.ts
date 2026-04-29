import type { TargetProfile, TargetRuntimeState, PreflightResult } from "@embed-agent/contracts";
import { ConnectionManager, type TransportType } from "./connection-manager.js";

export class TargetManager {
  constructor(
    private cm: ConnectionManager,
    private targetStore: {
      get(targetId: string): Promise<TargetProfile | null>;
      getState(targetId: string): Promise<TargetRuntimeState | null>;
      updateState(targetId: string, patch: Partial<TargetRuntimeState>): Promise<void>;
    },
  ) {}

  async preflight(targetId: string, requiredTransports: TransportType[], artifactPath: string): Promise<PreflightResult> {
    const target = await this.targetStore.get(targetId);
    if (!target) {
      return { all_passed: false, checks: [{ check: "target_exists", passed: false, error: "not found" }], failure_type: "host" };
    }

    const checks: PreflightResult["checks"] = [];

    for (const transport of requiredTransports) {
      const conn = this.cm.getConnection(target, transport);
      if (!conn) {
        checks.push({ check: `${transport}_available`, passed: false, error: "transport not configured" });
        continue;
      }
      try {
        await conn.connect();
        checks.push({ check: `${transport}_open`, passed: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        checks.push({ check: `${transport}_open`, passed: false, error: msg });
      }
    }

    // Check artifact file
    try {
      const local = this.cm.getConnection(target, "local");
      if (local?.exec) {
        const result = await local.exec(`test -f ${artifactPath}`, 5);
        checks.push({ check: "artifact_exists", passed: result.exit_code === 0 });
      }
    } catch {
      checks.push({ check: "artifact_exists", passed: false });
    }

    const failed = checks.filter(c => !c.passed);
    const failureType = failed.some(c => c.check.includes("serial") || c.check.includes("adb") || c.check.includes("fastboot"))
      ? "device" : "host";

    return { all_passed: failed.length === 0, checks, failure_type: failureType };
  }

  async recover(targetId: string): Promise<boolean> {
    const target = await this.targetStore.get(targetId);
    if (!target) return false;

    // Try reboot
    const rebootMethod = target.recovery?.reboot_method ?? "adb";
    try {
      const conn = this.cm.getConnection(target, rebootMethod);
      if (conn?.exec) {
        await conn.exec("reboot", 30);
      }
    } catch {
      return false;
    }

    // Verify basic functionality after reboot
    if (target.connections.adb) {
      try {
        const adb = this.cm.getConnection(target, "adb");
        await adb?.connect?.();
      } catch {
        return false;
      }
    }

    return true;
  }

  isBusy(state: TargetRuntimeState | null): boolean {
    if (!state) return false;
    return !["idle", "offline"].includes(state.state);
  }
}
