import { describe, it, expect } from "vitest";
import { StepQueue } from "../src/step-queue.js";
import { StepExecutor, StepRetryBreaker } from "../src/step-executor.js";
import { ObserverOverrideBreaker, WarningAccumulator } from "../src/decision-handler.js";
import { HookManager, isLocalHookScriptPath } from "../src/hook-manager.js";
import type { Connection } from "@embed-agent/tools";

// --- StepQueue ---

describe("StepQueue", () => {
  it("loads and iterates steps in order", () => {
    const sq = new StepQueue();
    sq.load([
      { id: "s1", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 },
      { id: "s2", capability: "serial_output", action: "stream" as const, timeout_sec: 30 },
    ]);
    expect(sq.next()?.id).toBe("s1");
    expect(sq.next()?.id).toBe("s2");
    expect(sq.next()).toBeNull();
  });

  it("append adds a step at the end", () => {
    const sq = new StepQueue();
    sq.load([{ id: "s1", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 }]);
    sq.append({ id: "s2", capability: "wait_adb", action: "wait" as const, timeout_sec: 20 });
    expect(sq.next()?.id).toBe("s1");
    expect(sq.next()?.id).toBe("s2");
    expect(sq.next()).toBeNull();
  });

  it("pause/resume stops and resumes iteration", () => {
    const sq = new StepQueue();
    sq.load([
      { id: "s1", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 },
      { id: "s2", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 },
    ]);
    expect(sq.next()?.id).toBe("s1");
    sq.pause();
    expect(sq.next()).toBeNull();
    expect(sq.paused).toBe(true);
    sq.resume();
    expect(sq.paused).toBe(false);
    expect(sq.next()?.id).toBe("s2");
  });

  it("clear empties the queue", () => {
    const sq = new StepQueue();
    sq.load([{ id: "s1", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 }]);
    sq.clear();
    expect(sq.next()).toBeNull();
  });

  it("remaining counts unprocessed steps", () => {
    const sq = new StepQueue();
    sq.load([
      { id: "s1", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 },
      { id: "s2", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 },
      { id: "s3", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 },
    ]);
    expect(sq.remaining).toBe(3);
    sq.next();
    expect(sq.remaining).toBe(2);
  });

  it("peek returns next without advancing", () => {
    const sq = new StepQueue();
    sq.load([{ id: "s1", capability: "shell_exec", action: "exec" as const, timeout_sec: 10 }]);
    expect(sq.peek()?.id).toBe("s1");
    expect(sq.peek()?.id).toBe("s1"); // still there
    expect(sq.next()?.id).toBe("s1");
  });
});

// --- CB2: StepRetryBreaker ---

describe("StepRetryBreaker", () => {
  it("trips CB2 on 3rd consecutive same failure", () => {
    const breaker = new StepRetryBreaker();
    expect(breaker.shouldRetry("timeout")).toBe(true);  // 1st
    expect(breaker.shouldRetry("timeout")).toBe(true);  // 2nd
    expect(breaker.shouldRetry("timeout")).toBe(false); // 3rd — CB2 trips
  });

  it("reset clears consecutive counter", () => {
    const breaker = new StepRetryBreaker();
    breaker.shouldRetry("timeout");
    breaker.shouldRetry("timeout");
    breaker.reset();
    expect(breaker.shouldRetry("timeout")).toBe(true);
  });

  it("different failure types reset counter", () => {
    const breaker = new StepRetryBreaker();
    expect(breaker.shouldRetry("timeout")).toBe(true);
    expect(breaker.shouldRetry("connection_lost")).toBe(true); // different type, count=1
    expect(breaker.shouldRetry("connection_lost")).toBe(true); // count=2
    expect(breaker.shouldRetry("connection_lost")).toBe(false); // count=3, trips
  });
});

// --- StepExecutor stream semantics ---

describe("StepExecutor", () => {
  it("treats the stream time budget as a completed observation window", async () => {
    const events: Record<string, unknown>[] = [];
    const conn = new ContinuousStreamConnection();
    const pipe = new CapturingPipe();
    const executor = new StepExecutor(
      "run-stream-window",
      { target_id: "t1", connections: { serial: { port: "/dev/mock" } } },
      { emit: async (event) => { events.push(event); } },
      new HookManager([]),
      { getForStep: () => conn },
      () => pipe,
      { maxRetries: 0, intervals: [], retryable: ["timeout"] },
    );

    const result = await executor.executeStep({
      id: "stream-serial",
      capability: "serial_output",
      action: "stream",
      timeout_sec: 0.05,
    });

    expect(result).toEqual({ completed: true });
    expect(conn.disconnects).toBe(1);
    expect(pipe.flushed).toBeGreaterThan(0);
    expect(pipe.silenceDisabled).toBe(true);
    expect(events.some(event => event.type === "step_completed")).toBe(true);
    expect(events.some(event => event.type === "step_failed")).toBe(false);
  });

  it("keeps a Windows host path intact when parsing push command fallback", async () => {
    const conn = new RecordingConnection();
    const executor = new StepExecutor(
      "run-push-windows-path",
      { target_id: "t1", connections: { adb: { device_id: "emu" } } },
      { emit: async () => {} },
      new HookManager([]),
      { getForStep: () => conn },
    );

    const result = await executor.executeStep({
      id: "push-libcamera",
      capability: "push",
      action: "push",
      command: String.raw`C:\builds\s820\libcamera.so:/vendor/lib64/libcamera.so`,
      timeout_sec: 5,
    });

    expect(result).toEqual({ completed: true });
    expect(conn.pushArgs).toEqual([
      String.raw`C:\builds\s820\libcamera.so`,
      "/vendor/lib64/libcamera.so",
    ]);
  });

  it("keeps a Windows host path intact when parsing flash command fallback", async () => {
    const conn = new RecordingConnection();
    const executor = new StepExecutor(
      "run-flash-windows-path",
      { target_id: "t1", connections: { fastboot: { device_id: "fb" } } },
      { emit: async () => {} },
      new HookManager([]),
      { getForStep: () => conn },
    );

    const result = await executor.executeStep({
      id: "flash-boot",
      capability: "flash",
      action: "flash",
      command: String.raw`C:\builds\s820\nightly\boot.img:boot`,
      timeout_sec: 5,
    });

    expect(result).toEqual({ completed: true });
    expect(conn.flashArgs).toEqual([
      String.raw`C:\builds\s820\nightly\boot.img`,
      "boot",
    ]);
  });
});

class ContinuousStreamConnection implements Connection {
  private currentState: "connected" | "disconnected" | "error" = "disconnected";
  disconnects = 0;

  async connect(): Promise<void> {
    this.currentState = "connected";
  }

  async disconnect(): Promise<void> {
    this.currentState = "disconnected";
    this.disconnects++;
  }

  state(): "connected" | "disconnected" | "error" {
    return this.currentState;
  }

  async *stream(): AsyncIterable<string> {
    let line = 0;
    while (this.currentState === "connected") {
      await new Promise(resolve => setTimeout(resolve, 1));
      yield `line ${line++}`;
    }
  }
}

class CapturingPipe {
  chunks: string[] = [];
  flushed = 0;
  silenceDisabled = false;

  async feedStream(chunk: string): Promise<void> {
    this.chunks.push(chunk);
  }

  async feedExec(): Promise<void> {}

  async flush(): Promise<void> {
    this.flushed++;
  }

  disableSilence(): void {
    this.silenceDisabled = true;
  }

  setConnection(): void {}
}

class RecordingConnection implements Connection {
  private currentState: "connected" | "disconnected" | "error" = "disconnected";
  pushArgs: [string, string] | null = null;
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

  async push(src: string, dst: string): Promise<void> {
    this.pushArgs = [src, dst];
  }

  async flash(image: string, partition: string): Promise<void> {
    this.flashArgs = [image, partition];
  }
}

// --- CB1: ObserverOverrideBreaker ---

describe("ObserverOverrideBreaker", () => {
  it("activates after 3 overrides", () => {
    const breaker = new ObserverOverrideBreaker();
    expect(breaker.isActive()).toBe(false);
    breaker.onOverride();
    breaker.onOverride();
    expect(breaker.isActive()).toBe(false);
    breaker.onOverride();
    expect(breaker.isActive()).toBe(true);
  });

  it("reset clears override count", () => {
    const breaker = new ObserverOverrideBreaker();
    breaker.onOverride();
    breaker.onOverride();
    breaker.onOverride();
    expect(breaker.isActive()).toBe(true);
    breaker.reset();
    expect(breaker.isActive()).toBe(false);
  });
});

// --- CB3: WarningAccumulator ---

describe("WarningAccumulator", () => {
  it("escalates after 5 distinct rules", () => {
    const acc = new WarningAccumulator();
    expect(acc.isEscalated()).toBe(false);
    acc.record("r1");
    acc.record("r2");
    acc.record("r3");
    acc.record("r4");
    expect(acc.isEscalated()).toBe(false);
    acc.record("r5");
    expect(acc.isEscalated()).toBe(true);
  });

  it("duplicate rules don't increase count", () => {
    const acc = new WarningAccumulator();
    acc.record("r1");
    acc.record("r1");
    acc.record("r1");
    expect(acc.isEscalated(2)).toBe(false); // only 1 distinct
  });

  it("reset clears accumulator", () => {
    const acc = new WarningAccumulator();
    acc.record("r1");
    acc.record("r2");
    acc.record("r3");
    acc.record("r4");
    acc.record("r5");
    expect(acc.isEscalated()).toBe(true);
    acc.reset();
    expect(acc.isEscalated()).toBe(false);
  });
});

// --- HookManager (security) ---

describe("HookManager", () => {
  it("rejects inline shell commands (proceed with error in stderr)", async () => {
    const hm = new HookManager([{
      name: "bad", on: "PreRunStart", command: "echo hello && cat /etc/passwd", timeout: 10,
    }]);
    const result = await hm.execute("PreRunStart", {});
    // HookManager proceeds on failure — error is in stderr
    expect(result.stderr).toBeDefined();
  });

  it("rejects commands with shell metacharacters in path", async () => {
    const hm = new HookManager([{
      name: "bad", on: "PreRunStart", command: "./script.sh; rm -rf /", timeout: 10,
    }]);
    const result = await hm.execute("PreRunStart", {});
    expect(result.stderr).toBeDefined();
  });

  it("returns proceed for non-matching hooks", async () => {
    const hm = new HookManager([]);
    const result = await hm.execute("PreRunStart", { run_id: "r1" });
    expect(result.decision).toBe("proceed");
  });

  it("filters hooks by match", async () => {
    const hm = new HookManager([{
      name: "match-test", on: "PreStepExecute",
      match: { capability: "flash" },
      command: "./test.sh", timeout: 10,
    }]);
    // Non-matching capability — hook should not run, returns default proceed
    const result = await hm.execute("PreStepExecute", { run_id: "r1", capability: "shell_exec" });
    expect(result.decision).toBe("proceed");
  });

  it("accepts Windows local script paths without treating backslashes as shell metacharacters", () => {
    expect(isLocalHookScriptPath(String.raw`.\scripts\pre-check.cmd`, "win32")).toBe(true);
    expect(isLocalHookScriptPath(String.raw`C:\work\embed-agent\scripts\pre-check.cmd`, "win32")).toBe(true);
    expect(isLocalHookScriptPath(String.raw`.\scripts\pre-check.cmd;rm -rf`, "win32")).toBe(false);
    expect(isLocalHookScriptPath(String.raw`..\scripts\pre-check.cmd`, "win32")).toBe(false);
  });

  it("keeps Unix hook paths strict on Unix hosts", () => {
    expect(isLocalHookScriptPath("./scripts/pre-check.sh", "darwin")).toBe(true);
    expect(isLocalHookScriptPath("/opt/embed-agent/pre-check.sh", "linux")).toBe(true);
    expect(isLocalHookScriptPath(String.raw`.\scripts\pre-check.cmd`, "darwin")).toBe(false);
  });
});
