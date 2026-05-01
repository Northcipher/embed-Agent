/**
 * ADB client abstraction — decouples AdbConnection from child_process.
 * Pattern borrowed from appium-adb's injectable `executable` config.
 */
import { execFile as cpExecFile, spawn as cpSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFile = promisify(cpExecFile);

// ============================================================
// Error classification — adapted from appium-adb's error pattern matching
// ============================================================

export type AdbDeviceState = "device" | "offline" | "unauthorized" | "no-permissions" | "unknown";

export class AdbError extends Error {
  constructor(
    message: string,
    public readonly code: AdbDeviceState,
    public readonly rawOutput?: string,
  ) {
    super(message);
    this.name = "AdbError";
  }
}

/** Classify ADB error output into a typed state. */
export function classifyAdbError(stderr: string, code?: number | null): AdbDeviceState {
  const text = stderr.toLowerCase();
  if (text.includes("not found") || text.includes("no devices") || text.includes("does not exist"))
    return "offline";
  if (text.includes("device offline"))
    return "offline";
  if (text.includes("unauthorized") || text.includes("no permissions"))
    return "unauthorized";
  if (text.includes("permission denied"))
    return "no-permissions";
  if (code && code !== 0) return "unknown";
  return "unknown";
}

/** Human-readable error hint for each device state. */
export function adbErrorHint(state: AdbDeviceState, deviceId: string): string {
  switch (state) {
    case "offline":
      return `ADB device "${deviceId}" is offline. Check USB connection, or run: adb kill-server && adb start-server`;
    case "unauthorized":
      return `ADB device "${deviceId}" is unauthorized. Unlock the device and tap "Allow USB debugging" on the popup.`;
    case "no-permissions":
      return `ADB device "${deviceId}" access denied. Verify the device is in developer mode and USB debugging is enabled.`;
    default:
      return `ADB device "${deviceId}" is in an unexpected state. Check "adb devices" output.`;
  }
}

// ============================================================
// ADB Client Interface (injectable for testing)
// ============================================================

export interface AdbExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface AdbClient {
  /** Run an adb command with args. Returns structured result or throws AdbError. */
  run(args: string[], timeoutMs: number): Promise<AdbExecResult>;
  /** Stream output from a persistent adb command (e.g. logcat). Yields lines until timeout. */
  stream?(args: string[], timeoutMs: number): AsyncIterable<string>;
}

// ============================================================
// Real ADB client — wraps child_process execFile
// ============================================================

export class RealAdbClient implements AdbClient {
  constructor(private adbPath = "adb") {}

  async run(args: string[], timeoutMs: number): Promise<AdbExecResult> {
    try {
      const { stdout, stderr } = await execFile(this.adbPath, args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        windowsHide: true,
      });
      return { stdout, stderr, exit_code: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      const stderr = err.stderr ?? "";
      const exitCode = err.code ?? 1;
      const state = classifyAdbError(stderr, exitCode);
      const sIdx = args.indexOf("-s");
      const deviceId = sIdx >= 0 && sIdx + 1 < args.length ? args[sIdx + 1]! : "unknown";
      const hint = adbErrorHint(state, deviceId);
      throw new AdbError(`${hint}\n  ADB stderr: ${stderr.slice(0, 200)}`, state, stderr);
    }
  }

  async *stream(args: string[], timeoutMs: number): AsyncIterable<string> {
    const proc = cpSpawn(this.adbPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const deadline = Date.now() + timeoutMs;

    try {
      for await (const line of rl) {
        if (Date.now() > deadline) break;
        yield line;
      }
    } finally {
      proc.kill("SIGTERM");
      rl.close();
      // Drain stderr to avoid zombie
      proc.stderr?.resume();
    }
  }
}
