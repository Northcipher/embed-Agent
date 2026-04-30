import { describe, it, expect } from "vitest";
import { LocalConnection } from "../src/local.js";
import { RingBuffer } from "../src/ring-buffer.js";
import { RuleDetector, type Rule } from "../src/rule-detector.js";
import { FakeConnection } from "../src/fake.js";

describe("LocalConnection", () => {
  it("exec echo", async () => {
    const c = new LocalConnection();
    const r = await c.exec!("echo hello", 5);
    expect(r.stdout.trim()).toBe("hello");
  });
});

describe("RingBuffer", () => {
  it("getWindow", () => {
    const rb = new RingBuffer(10);
    for (let i = 0; i < 10; i++) rb.push(`line${i}`);
    expect(rb.getWindow(5, 2, 2)).toHaveLength(5);
  });

  it("getWindow captures after_lines when available", () => {
    const rb = new RingBuffer(10);
    // push 5 lines, then get window at line 2 with 2 after
    for (let i = 0; i < 5; i++) rb.push(`line${i}`);
    const w = rb.getWindow(2, 1, 2);
    expect(w).toEqual(["line1", "line2", "line3", "line4"]);
  });
});

describe("RuleDetector", () => {
  // Use after_lines: 0 so flushPending fires immediately on next tick
  const rules: Rule[] = [{ id: "panic", kind: "pattern", pattern: /panic/i, severity: "fatal", source: "system", debounce_sec: 30, capture: { before_lines: 2, after_lines: 2, ref: "panic-ref" } }];

  it("detect defers emission until flushPending", async () => {
    const events: Record<string, unknown>[] = [];
    const rb = new RingBuffer();
    const rd = new RuleDetector(rb, { emit: e => events.push(e) });
    rd.loadRunRules(rules, [], []);
    for (let i = 0; i < 5; i++) rb.push(`line${i}`);
    rd.detect("kernel panic!", 4);
    // events NOT emitted yet — pending
    expect(events).toHaveLength(0);
    // after flushAllPending, events are emitted
    await rd.flushAllPending();
    expect(events).toHaveLength(1);
    expect(events[0].rule_id).toBe("panic");
  });

  it("no match = no event after flush", async () => {
    const events: Record<string, unknown>[] = [];
    const rd = new RuleDetector(new RingBuffer(), { emit: e => events.push(e) });
    rd.loadRunRules(rules, [], []);
    rd.detect("all good", 0);
    await rd.flushAllPending();
    expect(events).toHaveLength(0);
  });

  it("step patterns load/clear", async () => {
    const events: Record<string, unknown>[] = [];
    const rd = new RuleDetector(new RingBuffer(), { emit: e => events.push(e) });
    rd.loadRunRules([], [], []);
    rd.loadStepPatterns(["foo error"]);
    rd.detect("foo error", 0);
    await rd.flushAllPending();
    expect(events).toHaveLength(1);
    rd.clearStepPatterns();
    const events2: Record<string, unknown>[] = [];
    const rd2 = new RuleDetector(new RingBuffer(), { emit: e => events2.push(e) });
    rd2.loadRunRules([], [], []);
    rd2.detect("foo error", 0);
    await rd2.flushAllPending();
    expect(events2).toHaveLength(0);
  });

  it("emits without evidence_refs when saveWindow fails", async () => {
    const events: Record<string, unknown>[] = [];
    const failingSaver = { saveWindow: async () => { throw new Error("disk full"); } };
    const rd = new RuleDetector(new RingBuffer(), { emit: e => events.push(e) }, failingSaver, "r1");
    rd.loadRunRules(rules, [], []);
    rd.detect("kernel panic!", 0);
    await rd.flushAllPending();
    expect(events).toHaveLength(1);
    expect(events[0].evidence_refs).toBeUndefined();
  });

  it("after_lines deferred until enough lines buffered", async () => {
    const events: Record<string, unknown>[] = [];
    const rb = new RingBuffer();
    const rd = new RuleDetector(rb, { emit: e => events.push(e) });
    rd.loadRunRules(rules, [], []);

    // Push a line, detect at lineIdx 0 (only hit line, no after lines)
    rb.push("kernel panic!");
    rd.detect("kernel panic!", 0);
    // After one push + flush, not enough after_lines yet (need 2)
    await rd.flushPending();
    expect(events).toHaveLength(0);

    // Push 2 more lines — now after_lines are available
    rb.push("after1");
    await rd.flushPending();
    rb.push("after2");
    await rd.flushPending();
    // Now the capture at lineIdx=0 has 2 after_lines in buffer
    expect(events).toHaveLength(1);
  });
});

describe("FakeConnection", () => {
  it("stream yields lines", async () => {
    const c = new FakeConnection();
    c.streamLines = ["a", "b"];
    const lines: string[] = [];
    for await (const l of c.stream!(10)) lines.push(l);
    expect(lines).toEqual(["a", "b"]);
  });
});
