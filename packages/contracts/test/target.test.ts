import { describe, it, expect } from "vitest";
import type { TargetState, TargetProfile } from "../src/target.js";

describe("TargetState", () => {
  const allStates: TargetState[] = [
    "idle", "preparing", "busy", "cleaning",
    "dirty", "recovery", "offline",
  ];

  it("should have 7 states", () => {
    expect(allStates).toHaveLength(7);
  });
});

describe("TargetProfile", () => {
  it("should accept minimal valid profile", () => {
    const profile: TargetProfile = {
      target_id: "board-01",
      connections: {},
      safety: {
        allow_flash: false,
        allow_reboot: false,
        allow_shell_exec: false,
        allow_power_cycle: false,
      },
    };
    expect(profile.target_id).toBe("board-01");
  });

  it("should accept full profile with all connections", () => {
    const profile: TargetProfile = {
      target_id: "board-01",
      display_name: "Test Board",
      connections: {
        serial: { port: "/dev/ttyUSB0", baud: 115200 },
        adb: { device_id: "ABC123" },
        fastboot: { device_id: "ABC123" },
        ssh: { host: "192.168.1.100", port: 22 },
      },
      flash: { method: "fastboot", artifact_type: "firmware_img" },
      recovery: { reboot_method: "adb", stable_artifact: "/builds/stable/boot.img" },
      safety: { allow_flash: true, allow_reboot: true, allow_shell_exec: true, allow_power_cycle: false },
      target_hints: {
        boot_markers: ["Booting Linux", "init started"],
        boot_sequence: [{ stage: "kernel", expected_duration: 15 }],
        fail_patterns: ["qcom_smd: timeout"],
        known_quirks: ["dmesg foo error"],
        recommended_checks: ["/vendor/bin/smoke_test"],
      },
      skills: ["pre-flash-check.yml"],
    };
    expect(profile.connections.serial?.port).toBe("/dev/ttyUSB0");
  });
});
