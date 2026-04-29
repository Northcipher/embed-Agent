import { describe, it, expect } from "vitest";
import { ConnectionManager } from "../src/connection-manager.js";
import type { TargetProfile } from "@embed-agent/contracts";

const targetWithAdb: TargetProfile = {
  target_id: "t1", connections: { adb: { device_id: "abc" } },
  safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
};

const targetWithSerial: TargetProfile = {
  target_id: "t2", connections: { serial: { port: "/dev/tty", baud: 115200 } },
  safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
};

describe("ConnectionManager", () => {
  it("should route exec shell_exec to adb", () => {
    const cm = new ConnectionManager();
    const conn = cm.getConnectionForStep(targetWithAdb, "exec", "shell_exec");
    expect(conn).not.toBeNull();
  });

  it("should route stream to serial", () => {
    const cm = new ConnectionManager();
    const conn = cm.getConnectionForStep(targetWithSerial, "stream", "watch_serial");
    expect(conn).not.toBeNull();
  });

  it("should return null when transport missing", () => {
    const cm = new ConnectionManager();
    const conn = cm.getConnectionForStep(targetWithAdb, "stream", "watch_serial");
    expect(conn).toBeNull(); // no serial connection
  });

  it("should route flash to fastboot", () => {
    const targetWithFb: TargetProfile = {
      target_id: "t3", connections: { fastboot: { device_id: "fb1" } },
      safety: { allow_flash: false, allow_reboot: false, allow_shell_exec: false, allow_power_cycle: false },
    };
    const cm = new ConnectionManager();
    const conn = cm.getConnectionForStep(targetWithFb, "flash", "flash");
    expect(conn).not.toBeNull();
  });
});
