import { describe, it, expect } from "vitest";
import { EventBus } from "../src/event-bus.js";

describe("EventBus", () => {
  it("should deliver events to subscribers", () => {
    const eb = new EventBus();
    const received: Record<string, unknown>[] = [];
    eb.subscribe(["run_started"], (e) => received.push(e));
    eb.emit({ type: "run_started", run_id: "r1", seq: 1 });
    expect(received).toHaveLength(1);
  });

  it("should support wildcard subscription", () => {
    const eb = new EventBus();
    const received: Record<string, unknown>[] = [];
    eb.subscribe(["*"], (e) => received.push(e));
    eb.emit({ type: "run_started", run_id: "r1", seq: 1 });
    eb.emit({ type: "run_completed", run_id: "r1", seq: 2 });
    expect(received).toHaveLength(2);
  });

  it("should maintain per-run ordering", () => {
    const eb = new EventBus();
    const order: number[] = [];
    eb.subscribe(["*"], (e) => order.push(e.seq as number));
    eb.emit({ type: "step_started", run_id: "r1", seq: 1 });
    eb.emit({ type: "step_completed", run_id: "r1", seq: 2 });
    eb.emit({ type: "run_completed", run_id: "r1", seq: 3 });
    expect(order).toEqual([1, 2, 3]);
  });

  it("should isolate different runs", () => {
    const eb = new EventBus();
    const r1: string[] = [];
    const r2: string[] = [];
    eb.subscribe(["*"], (e) => {
      if (e.run_id === "r1") r1.push(e.type as string);
      if (e.run_id === "r2") r2.push(e.type as string);
    });
    eb.emit({ type: "a", run_id: "r1", seq: 1 });
    eb.emit({ type: "b", run_id: "r2", seq: 1 });
    expect(r1).toEqual(["a"]);
    expect(r2).toEqual(["b"]);
  });

  it("should return unsubscribe function", () => {
    const eb = new EventBus();
    const received: Record<string, unknown>[] = [];
    const unsub = eb.subscribe(["test"], (e) => received.push(e));
    eb.emit({ type: "test", seq: 1 });
    expect(received).toHaveLength(1);
    unsub();
    eb.emit({ type: "test", seq: 2 });
    expect(received).toHaveLength(1);
  });
});
