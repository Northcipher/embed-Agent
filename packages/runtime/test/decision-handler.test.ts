import { describe, it, expect } from "vitest";
import { DecisionHandler } from "../src/decision-handler.js";
import type { Decision } from "@embed-agent/contracts";

describe("DecisionHandler", () => {
  it("should track override count for circuit breaker", () => {
    const dh = new DecisionHandler({ emit: () => {}, subscribe: () => () => {} } as never, {} as never, {} as never);
    expect(dh.isObserverBreakerActive()).toBe(false);
    dh.onOverride();
    dh.onOverride();
    expect(dh.isObserverBreakerActive()).toBe(false);
    dh.onOverride();
    expect(dh.isObserverBreakerActive()).toBe(true);
  });

  it("should track warning escalation", () => {
    const dh = new DecisionHandler({ emit: () => {}, subscribe: () => () => {} } as never, {} as never, {} as never);
    dh.recordWarning("r1");
    dh.recordWarning("r2");
    dh.recordWarning("r3");
    dh.recordWarning("r4");
    expect(dh.isWarningEscalated()).toBe(false);
    dh.recordWarning("r5");
    expect(dh.isWarningEscalated()).toBe(true);
  });

  it("should reset for new run", () => {
    const dh = new DecisionHandler({ emit: () => {}, subscribe: () => () => {} } as never, {} as never, {} as never);
    dh.onOverride(); dh.onOverride(); dh.onOverride();
    dh.recordWarning("r1"); dh.recordWarning("r2"); dh.recordWarning("r3");
    dh.recordWarning("r4"); dh.recordWarning("r5");
    expect(dh.isObserverBreakerActive()).toBe(true);
    expect(dh.isWarningEscalated()).toBe(true);
    dh.resetForNewRun();
    expect(dh.isObserverBreakerActive()).toBe(false);
    expect(dh.isWarningEscalated()).toBe(false);
  });

  it("should execute stop decision", async () => {
    let interrupted = false;
    let cleared = false;
    const se = { interrupt: () => { interrupted = true; }, extendTimeout: () => {} };
    const sq = { append: () => {}, clear: () => { cleared = true; }, pause: () => {} };
    const dh = new DecisionHandler({ emit: () => {}, subscribe: () => () => {} } as never, se, sq);
    await dh.executeDecision({ decision: "stop", reason: "test", confidence: 0.9, reasoning_trace: "", evidence_refs: [] });
    expect(interrupted).toBe(true);
    expect(cleared).toBe(true);
  });

  it("should execute extend_wait decision", async () => {
    let extended = 0;
    const se = { interrupt: () => {}, extendTimeout: (s: number) => { extended = s; } };
    const sq = { append: () => {}, clear: () => {}, pause: () => {} };
    const dh = new DecisionHandler({ emit: () => {}, subscribe: () => () => {} } as never, se, sq);
    await dh.executeDecision({ decision: "extend_wait", reason: "test", confidence: 0.7, reasoning_trace: "", evidence_refs: [], params: { extra_wait_sec: 30 } });
    expect(extended).toBe(30);
  });
});
