import { describe, it, expect } from "vitest";
import { EventBus } from "../src/event-bus.js";

describe("EventBus", () => {
  it("emit delivers to matching subscriber", () => {
    const eb = new EventBus();
    const received: Record<string, unknown>[] = [];
    eb.subscribe(["test_event"], e => received.push(e));
    eb.emit({ type: "test_event", payload: { x: 1 } });
    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ x: 1 });
  });

  it("* wildcard receives all events", () => {
    const eb = new EventBus();
    const received: Record<string, unknown>[] = [];
    eb.subscribe(["*"], e => received.push(e));
    eb.emit({ type: "foo" });
    eb.emit({ type: "bar" });
    expect(received).toHaveLength(2);
  });

  it("unsubscribe stops delivery", () => {
    const eb = new EventBus();
    const received: Record<string, unknown>[] = [];
    const unsub = eb.subscribe(["e"], e => received.push(e));
    eb.emit({ type: "e" });
    expect(received).toHaveLength(1);
    unsub();
    eb.emit({ type: "e" });
    expect(received).toHaveLength(1);
  });

  it("handler error does not break other subscribers", () => {
    const eb = new EventBus();
    const received: string[] = [];
    eb.subscribe(["e"], () => { throw new Error("bang"); });
    eb.subscribe(["e"], e => received.push((e as { type: string }).type));
    eb.emit({ type: "e" });
    expect(received).toEqual(["e"]);
  });

  it("subscribe multiple types at once", () => {
    const eb = new EventBus();
    const received: string[] = [];
    eb.subscribe(["a", "b"], e => received.push((e as { type: string }).type));
    eb.emit({ type: "a" });
    eb.emit({ type: "b" });
    eb.emit({ type: "c" });
    expect(received).toEqual(["a", "b"]);
  });
});
