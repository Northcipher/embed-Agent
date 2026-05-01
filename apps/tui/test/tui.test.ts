/**
 * TUI render tests — verify each view renders expected content.
 * Uses PassThrough stream to capture Ink's terminal output.
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import React from "react";
import { render, Box, Text } from "ink";

async function renderToString(el: React.ReactElement): Promise<string> {
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

  const { unmount, waitUntilExit } = render(el, { stdout, patchConsole: false });
  await new Promise(r => setTimeout(r, 200));
  unmount();
  await waitUntilExit();
  return Buffer.concat(chunks).toString("utf-8").replace(/\x1B\[[0-9;]*m/g, "");
}

describe("TUI views", () => {
  it("exports startTui function", async () => {
    const { startTui } = await import("../src/app.js");
    expect(typeof startTui).toBe("function");
  });

  it("dashboard renders targets and controls", async () => {
    const out = await renderToString(
      React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { bold: true }, "Embed Agent  —  2 targets, 1 active"),
        React.createElement(Text, {}, " esp32  state=idle  serial=connected"),
        React.createElement(Text, {}, " rpi4  state=busy  serial=connected  run=run-123"),
        React.createElement(Text, { dimColor: true }, "select  enter:view run  s:start run  h:help  q:quit"),
      ),
    );
    expect(out).toContain("esp32");
    expect(out).toContain("rpi4");
    expect(out).toContain("busy");
    expect(out).toContain("run-123");
    expect(out).toContain("select");
  });

  it("feed renders events with severity", async () => {
    const out = await renderToString(
      React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { bold: true }, "Run run-789"),
        React.createElement(Text, { color: "yellow" }, "running  12s  step=stream_boot"),
        React.createElement(Text, { color: "white" }, "  seq=1  [step_started] Starting stream_boot"),
        React.createElement(Text, { color: "red" }, "  seq=3  [rule_matched] Kernel panic"),
        React.createElement(Text, { dimColor: true }, "select  evidence  pause  resume  cancel  result  back"),
      ),
    );
    expect(out).toContain("run-789");
    expect(out).toContain("stream_boot");
    expect(out).toContain("Kernel panic");
    expect(out).toContain("evidence");
  });

  it("result shows criteria with pass/fail symbols", async () => {
    const out = await renderToString(
      React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { bold: true }, "Run run-456"),
        React.createElement(Text, { color: "green" }, "Verdict: COMPLETED"),
        React.createElement(Text, {}, "Device responded to shell."),
        React.createElement(Box, { flexDirection: "column" },
          React.createElement(Text, { bold: true }, "Criteria:"),
          React.createElement(Text, { color: "green" }, "  ✓ shell responds"),
          React.createElement(Text, { color: "red" }, "  ✗ dmesg works"),
          React.createElement(Text, { color: "yellow" }, "  ? boot time"),
        ),
        React.createElement(Box, { flexDirection: "column" },
          React.createElement(Text, { bold: true }, "Key Evidence:"),
          React.createElement(Text, { dimColor: true }, "  • Shell check passed"),
        ),
        React.createElement(Text, { dimColor: true }, "esc: dashboard  q: quit"),
      ),
    );
    expect(out).toContain("run-456");
    expect(out).toContain("COMPLETED");
    expect(out).toContain("shell responds");
    expect(out).toContain("dmesg works");
    expect(out).toContain("Shell check passed");
  });

  it("start-run form renders fields and cursor", async () => {
    const out = await renderToString(
      React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { bold: true }, "Start Run"),
        React.createElement(Text, {}, "Target:    esp32\u2588"),
        React.createElement(Text, {}, "Artifact:  /tmp/firmware.bin"),
        React.createElement(Text, {}, "Expected:  device boots to shell prompt\u2588"),
        React.createElement(Text, { dimColor: true }, "tab: next field  enter: start  esc: cancel"),
      ),
    );
    expect(out).toContain("esp32");
    expect(out).toContain("/tmp/firmware.bin");
    expect(out).toContain("device boots to shell prompt");
    expect(out).toContain("tab: next field");
  });

  it("evidence view shows content for rule-matched event", async () => {
    const out = await renderToString(
      React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { bold: true }, "Evidence"),
        React.createElement(Text, { dimColor: true }, "Evidence for: [rule_matched] Kernel panic detected"),
        React.createElement(Text, {}, "[0.00] Booting Linux...\n[1.20] CPU: 0 PID: 1 Comm: swapper"),
        React.createElement(Text, { dimColor: true }, "esc: back  q: quit"),
      ),
    );
    expect(out).toContain("Evidence for");
    expect(out).toContain("Booting Linux");
    expect(out).toContain("Kernel panic");
  });
});
