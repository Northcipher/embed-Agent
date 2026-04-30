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
});

describe("RuleDetector", () => {
  const rules: Rule[] = [{ id: "panic", kind: "pattern", pattern: /panic/i, severity: "fatal", source: "system", debounce_sec: 30 }];

  it("detect pattern emits event", () => {
    const events: Record<string, unknown>[] = [];
    const rd = new RuleDetector(new RingBuffer(), { emit: e => events.push(e) });
    rd.loadRunRules(rules, [], []);
    rd.detect("kernel panic!", 0);
    expect(events).toHaveLength(1);
    expect(events[0].rule_id).toBe("panic");
  });

  it("no match = no event", () => {
    const events: Record<string, unknown>[] = [];
    const rd = new RuleDetector(new RingBuffer(), { emit: e => events.push(e) });
    rd.loadRunRules(rules, [], []);
    rd.detect("all good", 0);
    expect(events).toHaveLength(0);
  });

  it("step patterns load/clear", () => {
    const events: Record<string, unknown>[] = [];
    const rd = new RuleDetector(new RingBuffer(), { emit: e => events.push(e) });
    rd.loadRunRules([], [], []);
    rd.loadStepPatterns(["foo error"]);
    rd.detect("foo error", 0);
    expect(events).toHaveLength(1);
    rd.clearStepPatterns();
    const events2: Record<string, unknown>[] = [];
    const rd2 = new RuleDetector(new RingBuffer(), { emit: e => events2.push(e) });
    rd2.loadRunRules([], [], []);
    rd2.detect("foo error", 0);
    expect(events2).toHaveLength(0);
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
