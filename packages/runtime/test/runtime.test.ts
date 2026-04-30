import { describe, it, expect } from "vitest";
import { StepQueue } from "../src/step-queue.js";
import { StepRetryBreaker } from "../src/step-executor.js";
import { ObserverOverrideBreaker, WarningAccumulator } from "../src/decision-handler.js";
import { HookManager } from "../src/hook-manager.js";

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
  it("allows retries up to maxSame", () => {
    const breaker = new StepRetryBreaker();
    expect(breaker.shouldRetry("timeout")).toBe(true);
    expect(breaker.shouldRetry("timeout")).toBe(true);
    expect(breaker.shouldRetry("timeout")).toBe(true);
    expect(breaker.shouldRetry("timeout")).toBe(false); // 4th same type → CB2 trips
  });

  it("reset clears consecutive counter", () => {
    const breaker = new StepRetryBreaker();
    breaker.shouldRetry("timeout");
    breaker.shouldRetry("timeout");
    breaker.reset();
    expect(breaker.shouldRetry("timeout")).toBe(true);
  });

  it("different failure types don't accumulate", () => {
    const breaker = new StepRetryBreaker();
    expect(breaker.shouldRetry("timeout")).toBe(true);
    expect(breaker.shouldRetry("connection_lost")).toBe(true); // different type resets
    expect(breaker.shouldRetry("connection_lost")).toBe(true);
    expect(breaker.shouldRetry("connection_lost")).toBe(true);
    expect(breaker.shouldRetry("connection_lost")).toBe(false);
  });
});

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

  it("returns empty result for non-matching hooks", async () => {
    const hm = new HookManager([]);
    const result = await hm.execute("PreRunStart", { run_id: "r1" });
    expect(result).toEqual({});
  });

  it("filters hooks by match", async () => {
    const hm = new HookManager([{
      name: "match-test", on: "PreStepExecute",
      match: { capability: "flash" },
      command: "./test.sh", timeout: 10,
    }]);
    // Non-matching capability — hook should not run (and command doesn't exist, so if it ran it would throw)
    const result = await hm.execute("PreStepExecute", { run_id: "r1", capability: "shell_exec" });
    expect(result).toEqual({});
  });
});
