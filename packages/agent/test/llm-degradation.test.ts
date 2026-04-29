import { describe, it, expect } from "vitest";
import { LLMDegradationBreaker } from "../src/llm-call-manager.js";

describe("LLMDegradationBreaker (CB4)", () => {
  it("should not be degraded initially", () => {
    const cb = new LLMDegradationBreaker();
    expect(cb.isDegraded("observer")).toBe(false);
  });

  it("should enter degraded after 3 failures", () => {
    const cb = new LLMDegradationBreaker();
    cb.recordFailure("observer");
    cb.recordFailure("observer");
    expect(cb.isDegraded("observer")).toBe(false);
    cb.recordFailure("observer");
    expect(cb.isDegraded("observer")).toBe(true);
  });

  it("should recover after success", () => {
    const cb = new LLMDegradationBreaker();
    cb.recordFailure("observer");
    cb.recordFailure("observer");
    cb.recordFailure("observer");
    expect(cb.isDegraded("observer")).toBe(true);
    cb.recordSuccess("observer");
    expect(cb.isDegraded("observer")).toBe(false);
  });

  it("should track each role independently", () => {
    const cb = new LLMDegradationBreaker();
    cb.recordFailure("planner");
    cb.recordFailure("planner");
    cb.recordFailure("planner");
    cb.recordFailure("observer");
    expect(cb.isDegraded("planner")).toBe(true);
    expect(cb.isDegraded("observer")).toBe(false);
  });
});
