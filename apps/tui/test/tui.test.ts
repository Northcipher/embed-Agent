import { describe, it, expect } from "vitest";

describe("TUI", () => {
  it("exports startTui function", async () => {
    const { startTui } = await import("../src/app.js");
    expect(typeof startTui).toBe("function");
  });
});
