import { describe, it, expect } from "vitest";

describe("TUI", () => {
  it("exports App stub", async () => {
    const { App } = await import("../src/app.js");
    expect(App.name).toBe("embed-agent-tui");
    expect(App.description).toContain("Terminal UI");
  });
});
