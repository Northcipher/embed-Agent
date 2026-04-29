import { describe, it, expect } from "vitest";
import { NotificationFilter } from "../src/notification-filter.js";

describe("NotificationFilter", () => {
  it("should send message on result_ready", async () => {
    const messages: string[] = [];
    const ch = { send: async (m: string) => { messages.push(m); } };
    const nf = new NotificationFilter([ch]);

    await nf.handleEvent({ type: "result_ready", run_id: "run-001", status: "failed", summary: "kernel panic" });
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toContain("kernel panic");
  });

  it("should deduplicate repeated messages", async () => {
    const messages: string[] = [];
    const ch = { send: async (m: string) => { messages.push(m); } };
    const nf = new NotificationFilter([ch]);

    await nf.handleEvent({ type: "result_ready", run_id: "run-001", status: "failed", summary: "test" });
    await nf.handleEvent({ type: "result_ready", run_id: "run-001", status: "failed", summary: "test" });
    expect(messages).toHaveLength(1); // deduped
  });

  it("should handle channel failure gracefully", async () => {
    const ch = { send: async () => { throw new Error("fail"); } };
    const nf = new NotificationFilter([ch]);
    await expect(nf.handleEvent({ type: "result_ready", run_id: "r1", status: "completed", summary: "ok" })).resolves.not.toThrow();
  });
});
