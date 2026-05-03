import { describe, it, expect } from "vitest";

// Basic smoke tests for CLI module exports
describe("CLI", () => {
  it("exports runCli function", async () => {
    const { runCli } = await import("../src/cli.js");
    expect(typeof runCli).toBe("function");
  });

  it("exports CommandHandler", async () => {
    const { CommandHandler } = await import("../src/command-handler.js");
    expect(typeof CommandHandler).toBe("function");
  });

  it("exports HttpCommandHandler", async () => {
    const { HttpCommandHandler } = await import("../src/http-client.js");
    expect(typeof HttpCommandHandler).toBe("function");
  });
});
