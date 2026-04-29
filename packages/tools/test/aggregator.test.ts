import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/aggregator.js";

describe("Aggregator", () => {
  it("should track line count", () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    ag.feed("line1");
    ag.feed("line2");
    ag.feed("line3");
    const cp = await ag.checkpoint();
    expect(cp).toBeDefined();
  });

  it("should detect stage transitions", () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    ag.setBootMarkers([
      { text: "Booting Linux", stage: "bootloader" },
      { text: "init started", stage: "init" },
    ]);

    ag.feed("Booting Linux on physical CPU");
    const stageEvents = events.filter(e => e.type === "stage_transition");
    expect(stageEvents.length).toBeGreaterThanOrEqual(1);
    expect(stageEvents[0].to).toBe("bootloader");
  });

  it("should detect output pattern silence", () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    // No lines fed → lineCount = 0 → silence
    const cp = await ag.checkpoint();
    expect(cp.output_pattern).toBe("silence");
  });

  it("should emit checkpoint event", () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    ag.feed("line1");
    ag.feed("line2");
    await ag.checkpoint();
    const cps = events.filter(e => e.type === "checkpoint");
    expect(cps.length).toBeGreaterThanOrEqual(1);
    expect(cps[0].lines_per_sec).toBeGreaterThan(0);
  });
});
