import { describe, it, expect } from "vitest";
import { NotificationFilter, LogChannel } from "../src/notification-filter.js";

describe("NotificationFilter", () => {
  it("sends notification for matching event with semantic category", async () => {
    const channel = new LogChannel();
    const events: Record<string, unknown>[] = [];
    const filter = new NotificationFilter(
      {
        subscribe: (_t, h) => {
          const fn = (e: Record<string, unknown>) => h(e);
          return () => {};
        },
        emit: async (e) => { events.push(e); },
      },
      { slack: channel },
    );

    await (filter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent({
      type: "result_ready",
      run_id: "r1",
      summary: "test completed",
      status: "completed",
      payload: { status: "completed", summary: "test completed", evidence_path: "/tmp", suggested_next: "none" },
    });

    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0].title).toContain("completed");
    // Verify notification_sent was emitted
    expect(events.some(e => e.type === "notification_sent")).toBe(true);
  });

  it("deduplicates per-target for target events", async () => {
    const channel = new LogChannel();
    const filter = new NotificationFilter(
      { subscribe: () => () => {}, emit: async () => {} },
      { slack: channel },
    );

    const handler = (filter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent.bind(filter);

    // target_state_changed with disconnected state → category "target_offline"
    await handler({ type: "target_state_changed", summary: "t1 disconnected", payload: { target_id: "t1", state: "disconnected" } });
    await handler({ type: "target_state_changed", summary: "t2 disconnected", payload: { target_id: "t2", state: "disconnected" } });

    // Different targets — both should send
    expect(channel.messages).toHaveLength(2);
  });

  it("throttles same target within window", async () => {
    const channel = new LogChannel();
    const filter = new NotificationFilter(
      { subscribe: () => () => {}, emit: async () => {} },
      { slack: channel },
    );

    const handler = (filter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent.bind(filter);

    await handler({ type: "target_state_changed", summary: "t1 offline", payload: { target_id: "t1", state: "disconnected" } });
    await handler({ type: "target_state_changed", summary: "t1 still offline", payload: { target_id: "t1", state: "disconnected" } });

    // Same target within throttle window — only 1
    expect(channel.messages).toHaveLength(1);
  });
});
