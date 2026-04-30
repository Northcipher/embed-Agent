import { describe, it, expect } from "vitest";
import { NotificationFilter, LogChannel } from "../src/notification-filter.js";

describe("NotificationFilter", () => {
  it("sends notification for matching event", async () => {
    const events: Record<string, unknown>[] = [];
    const channel = new LogChannel();
    const filter = new NotificationFilter(
      { subscribe: (_t, h) => { events.push; const fn = (e: Record<string, unknown>) => h(e); return () => {}; } },
      { slack: channel },
    );

    // Directly test the template rendering via handleEvent
    await (filter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent({
      type: "result_ready",
      run_id: "r1",
      summary: "test completed",
      status: "completed",
      payload: { status: "completed", summary: "test completed" },
    });

    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0].title).toContain("completed");
  });

  it("deduplicates within throttle window", async () => {
    const channel = new LogChannel();
    const filter = new NotificationFilter(
      {
        subscribe: (_t: string[], _h: (e: Record<string, unknown>) => void) => { return () => {}; },
      },
      { slack: channel },
      {
        test_event: { title: "{{summary}}", body: "body", channel: "slack", throttle_sec: 60 },
      },
    );

    const handler = (filter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent.bind(filter);
    await handler({ type: "test_event", run_id: "r1", summary: "first" });
    await handler({ type: "test_event", run_id: "r1", summary: "second" });

    // Second should be throttled
    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0].title).toBe("first");
  });

  it("ignores events without matching template", async () => {
    const channel = new LogChannel();
    const filter = new NotificationFilter(
      {
        subscribe: (_t: string[], _h: (e: Record<string, unknown>) => void) => { return () => {}; },
      },
      { slack: channel },
    );

    const handler = (filter as unknown as { handleEvent(e: Record<string, unknown>): Promise<void> }).handleEvent.bind(filter);
    await handler({ type: "unknown_event", run_id: "r1", summary: "test" });

    expect(channel.messages).toHaveLength(0);
  });
});
