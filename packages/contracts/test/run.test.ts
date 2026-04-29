import { describe, it, expect } from "vitest";
import { NON_TERMINAL_STATES, TERMINAL_STATES, type RunState } from "../src/run.js";

describe("RunState", () => {
  const allStates: RunState[] = [
    "planning", "running", "paused",
    "collecting_evidence", "finalizing",
    "completed", "failed", "cancelled",
  ];

  it("should have 8 states", () => {
    expect(allStates).toHaveLength(8);
  });

  it("NON_TERMINAL_STATES should be 5 states", () => {
    expect(NON_TERMINAL_STATES).toHaveLength(5);
    expect(NON_TERMINAL_STATES).toContain("planning");
    expect(NON_TERMINAL_STATES).toContain("running");
    expect(NON_TERMINAL_STATES).toContain("paused");
    expect(NON_TERMINAL_STATES).toContain("collecting_evidence");
    expect(NON_TERMINAL_STATES).toContain("finalizing");
  });

  it("TERMINAL_STATES should be 3 states", () => {
    expect(TERMINAL_STATES).toHaveLength(3);
    expect(TERMINAL_STATES).toContain("completed");
    expect(TERMINAL_STATES).toContain("failed");
    expect(TERMINAL_STATES).toContain("cancelled");
  });

  it("no overlap between terminal and non-terminal", () => {
    const overlap = NON_TERMINAL_STATES.filter(s => TERMINAL_STATES.includes(s));
    expect(overlap).toHaveLength(0);
  });
});
