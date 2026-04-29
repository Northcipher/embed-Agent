import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityAdapterRegistry } from "@artifact-validation/adapters";
import {
  TargetProfileSchema,
  type CapabilityName,
  type CapabilityStatus,
  type Constraints,
  type TargetProfile
} from "@artifact-validation/contracts";

export async function loadTargetProfilesFromDir(dir: string): Promise<TargetProfile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const profiles: TargetProfile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    profiles.push(TargetProfileSchema.parse(raw));
  }
  return profiles;
}

export function buildTargetProfileMap(profiles: TargetProfile[] | undefined): Map<string, TargetProfile> | undefined {
  if (profiles === undefined) {
    return undefined;
  }
  const map = new Map<string, TargetProfile>();
  for (const profile of profiles) {
    if (map.has(profile.target_id)) {
      throw new Error(`duplicate target profile ${profile.target_id}`);
    }
    map.set(profile.target_id, profile);
  }
  return map;
}

export function inferTargetCapabilities(options: {
  adapters: CapabilityAdapterRegistry;
  targetProfile?: TargetProfile | undefined;
  constraints?: Constraints | undefined;
}): CapabilityStatus[] {
  return P0_CAPABILITIES.map(capability => ({
    name: capability,
    available: options.adapters.get(capability) !== undefined && capabilityAllowedByProfile(capability, options.targetProfile, options.constraints),
    requires: capabilityRequires(capability),
    limits: capabilityLimits(capability),
    risk: capabilityRisk(capability)
  }));
}

export const P0_CAPABILITIES: CapabilityName[] = [
  "flash",
  "push",
  "watch_serial",
  "wait_adb",
  "shell_exec",
  "check_process",
  "collect_logs",
  "save_snapshot"
];

export function capabilityRisk(capability: CapabilityName): CapabilityStatus["risk"] {
  return capability === "flash" || capability === "push" || capability === "shell_exec" ? "medium" : "low";
}

export function capabilityRequires(capability: CapabilityName): CapabilityStatus["requires"] {
  if (capability === "flash") {
    return { connection: "fastboot" };
  }
  if (capability === "watch_serial") {
    return { connection: "serial" };
  }
  if (capability === "save_snapshot") {
    return { connection: "evidence_store" };
  }
  return { connection: "adb" };
}

export function capabilityLimits(capability: CapabilityName): CapabilityStatus["limits"] {
  const defaultTimeouts: Record<CapabilityName, number> = {
    flash: 300,
    push: 60,
    watch_serial: 180,
    wait_adb: 180,
    shell_exec: 60,
    check_process: 30,
    collect_logs: 120,
    save_snapshot: 30
  };
  return {
    default_timeout_sec: defaultTimeouts[capability],
    max_duration_sec: capability === "watch_serial" ? 600 : defaultTimeouts[capability]
  };
}

function capabilityAllowedByProfile(capability: CapabilityName, profile: TargetProfile | undefined, constraints: Constraints | undefined): boolean {
  if (capability === "flash" && constraints?.allow_flash === false) {
    return false;
  }
  if ((capability === "push" || capability === "shell_exec") && constraints?.allow_shell_exec === false) {
    return false;
  }
  if (profile === undefined) {
    return true;
  }
  switch (capability) {
    case "flash":
      return profile.flash !== undefined && profile.safety.allow_flash === true;
    case "push":
    case "shell_exec":
      return profile.connections.adb !== undefined && profile.safety.allow_shell_exec !== false;
    case "wait_adb":
    case "check_process":
      return profile.connections.adb !== undefined;
    case "watch_serial":
      return profile.connections.serial !== undefined;
    case "collect_logs":
      return profile.connections.adb !== undefined || profile.connections.serial !== undefined;
    case "save_snapshot":
      return true;
  }
}
