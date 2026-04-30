/**
 * RuleDetector Integration Test
 * Verifies: pattern match → rule_matched event → DecisionHandler receives it
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventBus } from "../../runtime/src/event-bus.js";
import { EventStore } from "../../stores/src/event-store.js";
import { OutputPipe } from "../src/output-pipe.js";
import { RingBuffer } from "../src/ring-buffer.js";
import { RuleDetector } from "../src/rule-detector.js";
import { Aggregator } from "../src/aggregator.js";

describe("RuleDetector integration", () => {
  const tmpDir = path.join(os.tmpdir(), `rd-${Date.now()}`);
  const eventBus = new EventBus();
  const eventStore = new EventStore(tmpDir);
  eventStore.subscribeToBus(eventBus);

  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("fatal pattern match → rule_matched event with run_id", async () => {
    const events: Record<string, unknown>[] = [];
    // Subscribe BEFORE emitting
    eventBus.subscribe(["*"], e => { events.push(e); });

    const rb = new RingBuffer(500);
    const rd = new RuleDetector(rb, eventBus, undefined, "r-test");
    rd.loadRunRules(
      [{ id: "kernel_panic", kind: "pattern", pattern: /Kernel panic/i, severity: "fatal", source: "system", debounce_sec: 0, capture: { before_lines: 1, after_lines: 0, ref: "panic-ref" } }],
      [], [],
    );

    // Push lines through the detect → flush cycle
    rb.push("boot start"); await rd.flushPending(); rd.detect("boot start", rb.totalPushed() - 1);
    rb.push("Kernel panic - not syncing"); await rd.flushPending(); rd.detect("Kernel panic - not syncing", rb.totalPushed() - 1);
    rb.push("halt"); await rd.flushPending(); rd.detect("halt", rb.totalPushed() - 1);
    await rd.flushAllPending();

    const matched = events.filter(e => e.type === "rule_matched");
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched[0]!.rule_id).toBe("kernel_panic");
    expect(matched[0]!.run_id).toBe("r-test");
    expect(matched[0]!.severity).toBe("fatal");
  });

  it("warning pattern with checkExitCode", async () => {
    const rb = new RingBuffer(500);
    const rd = new RuleDetector(rb, eventBus, undefined, "r-warn");
    rd.loadRunRules([], [
      { id: "segfault", kind: "pattern", pattern: /segfault/i, severity: "warning", source: "system", debounce_sec: 0 },
    ], []);

    const events: Record<string, unknown>[] = [];
    eventBus.subscribe(["rule_matched"], e => { events.push(e); });

    rb.push("process segfault at 0x00"); await rd.flushPending(); rd.detect("process segfault at 0x00", rb.totalPushed() - 1);
    await rd.flushAllPending();

    const matched = events.filter(e => e.rule_id === "segfault");
    expect(matched.length).toBeGreaterThanOrEqual(1);
  });

  it("OutputPipe pipeline: feedStream → rule_matched event", async () => {
    const events: Record<string, unknown>[] = [];
    eventBus.subscribe(["rule_matched"], e => { events.push(e); });

    const rb = new RingBuffer(500);
    const rd = new RuleDetector(rb, eventBus, undefined, "r-pipe");
    rd.loadRunRules(
      [{ id: "oom", kind: "pattern", pattern: /Out of memory/i, severity: "fatal", source: "system", debounce_sec: 0, capture: { before_lines: 1, after_lines: 0, ref: "oom-ref" } }],
      [], [],
    );
    const ag = new Aggregator(eventBus);
    const ew = { append: (_d: string) => {} };
    const pipe = new OutputPipe(ew, rb, rd, ag, eventBus, "s1");
    pipe.setRunId("r-pipe");

    // OutputPipe splits by newline internally
    await pipe.feedStream("line1\nOut of memory: killed\nline3\n");
    await pipe.flush();

    const matched = events.filter(e => e.type === "rule_matched" && e.rule_id === "oom");
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched[0]!.run_id).toBe("r-pipe");
  });
});
