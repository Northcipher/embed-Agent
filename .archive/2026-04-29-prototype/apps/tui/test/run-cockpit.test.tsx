import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { RunCockpit, fixtureRunCockpitData } from "../src/index.js";

describe("RunCockpit", () => {
  it("renders the run status, timeline, evidence, and result availability from props", () => {
    const output = renderToString(<RunCockpit data={fixtureRunCockpitData} />, {
      columns: 100
    });

    expect(output).toContain("Run Cockpit");
    expect(output).toContain("run-001");
    expect(output).toContain("running");
    expect(output).toContain("board-01");
    expect(output).toContain("watch_serial");
    expect(output).toContain("kernel panic");
    expect(output).toContain("serial:last-200-lines");
    expect(output).toContain("result unavailable");
  });
});
