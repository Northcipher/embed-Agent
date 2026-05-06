import { describe, expect, it } from "vitest";
import { TargetManager } from "../src/target-manager.js";
import type { Connection } from "../src/connection.js";

describe("TargetManager", () => {
  it("keeps a Windows stable artifact path intact during recovery flash", async () => {
    const flashConn = new RecordingConnection();
    const rebootConn = new RecordingConnection();
    const store = new MemoryTargetStore({
      target_id: "board-1",
      connections: { fastboot: { device_id: "fb" }, adb: { device_id: "adb" } },
      recovery: {
        reboot_method: "adb",
        stable_artifact: String.raw`C:\builds\s820\stable\boot.img:boot`,
      },
    });
    const cm = {
      get: (_target: { target_id: string }, transport: string): Connection | null => {
        if (transport === "fastboot") return flashConn;
        if (transport === "adb") return rebootConn;
        return null;
      },
    };

    const tm = new TargetManager(cm as never, store);
    await expect(tm.recover("board-1")).resolves.toBe(true);
    expect(flashConn.flashArgs).toEqual([
      String.raw`C:\builds\s820\stable\boot.img`,
      "boot",
    ]);
  });
});

class MemoryTargetStore {
  constructor(
    private profile: {
      target_id: string;
      connections: Record<string, unknown>;
      recovery?: { reboot_method?: string; stable_artifact?: string };
    },
  ) {}

  async get(id: string): Promise<{
    target_id: string;
    connections: Record<string, unknown>;
    recovery?: { reboot_method?: string; stable_artifact?: string };
  } | null> {
    return id === this.profile.target_id ? this.profile : null;
  }

  async getState(): Promise<{ state: string; current_run_id?: string } | null> {
    return { state: "idle" };
  }

  async updateState(): Promise<void> {}
}

class RecordingConnection implements Connection {
  private currentState: "connected" | "disconnected" | "error" = "disconnected";
  flashArgs: [string, string] | null = null;

  async connect(): Promise<void> {
    this.currentState = "connected";
  }

  async disconnect(): Promise<void> {
    this.currentState = "disconnected";
  }

  state(): "connected" | "disconnected" | "error" {
    return this.currentState;
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
    return { stdout: command === "reboot" ? "rebooting\n" : "", stderr: "", exit_code: 0 };
  }

  async flash(image: string, partition: string): Promise<void> {
    this.flashArgs = [image, partition];
  }
}
