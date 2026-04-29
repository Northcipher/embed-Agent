import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/aggregator.js";

describe("Aggregator", () => {
  it("should track line count", async () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    ag.feed("line1"); ag.feed("line2"); ag.feed("line3");
    const cp = await ag.checkpoint();
    expect(cp).toBeDefined();
  });

  it("should detect stage transitions", () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    ag.setBootMarkers([{ text: "Booting Linux", stage: "bootloader" }]);
    ag.feed("Booting Linux on physical CPU");
    expect(events.some(e => e.type === "stage_transition")).toBe(true);
  });

  it("should detect output pattern silence", async () => {
    const ag = new Aggregator("step-1", { emit: () => {} });
    const cp = await ag.checkpoint();
    expect(cp.output_pattern).toBe("silence");
  });

  it("should emit checkpoint event", async () => {
    const events: Record<string, unknown>[] = [];
    const ag = new Aggregator("step-1", { emit: (e) => events.push(e) });
    ag.feed("line1"); ag.feed("line2");
    await ag.checkpoint();
    expect(events.some(e => e.type === "checkpoint")).toBe(true);
  });
});
