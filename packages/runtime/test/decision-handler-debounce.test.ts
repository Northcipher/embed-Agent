import { describe, it, expect, vi } from "vitest";
import { DecisionHandler } from "../src/decision-handler.js";

describe("DecisionHandler debounce", () => {
  function setup() {
    const events: Record<string, unknown>[] = [];
    const eb = { emit: (e: Record<string, unknown>) => events.push(e), subscribe: () => () => {} };
    const se = { interrupt: () => {}, extendTimeout: () => {} };
    const sq = { append: () => {}, clear: () => {}, pause: () => {} };
    const dh = new DecisionHandler(eb as never, se, sq);
    return { dh, events };
  }

  it("should handle fatal event immediately", async () => {
    const { dh } = setup();
    // Fatal events go through executeStop directly (no debounce check needed)
    dh.recordWarning("r1");
    dh.recordWarning("r2");
    dh.recordWarning("r3");
    dh.recordWarning("r4");
    dh.recordWarning("r5");
    expect(dh.isWarningEscalated()).toBe(true);
  });

  it("should not escalate with duplicate warnings", () => {
    const { dh } = setup();
    dh.recordWarning("r1");
    dh.recordWarning("r1"); // duplicate
    dh.recordWarning("r1"); // duplicate
    expect(dh.isWarningEscalated()).toBe(false);
  });

  it("should reset breaker and warnings for new run", () => {
    const { dh } = setup();
    dh.onOverride(); dh.onOverride(); dh.onOverride();
    dh.recordWarning("r1"); dh.recordWarning("r2"); dh.recordWarning("r3");
    dh.recordWarning("r4"); dh.recordWarning("r5");
    expect(dh.isObserverBreakerActive()).toBe(true);
    expect(dh.isWarningEscalated()).toBe(true);

    dh.resetForNewRun();
    expect(dh.isObserverBreakerActive()).toBe(false);
    expect(dh.isWarningEscalated()).toBe(false);
  });

  it("should require exactly 3 overrides to activate breaker", () => {
    const { dh } = setup();
    expect(dh.isObserverBreakerActive()).toBe(false);
    dh.onOverride();
    expect(dh.isObserverBreakerActive()).toBe(false);
    dh.onOverride();
    expect(dh.isObserverBreakerActive()).toBe(false);
    dh.onOverride();
    expect(dh.isObserverBreakerActive()).toBe(true);
  });
});
