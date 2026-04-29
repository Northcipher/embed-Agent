import { describe, it, expect } from "vitest";
import { OutputPipe } from "../src/output-pipe.js";
import { RingBuffer } from "../src/ring-buffer.js";

describe("OutputPipe", () => {
  function setup() {
    const evidence: string[] = [];
    const ew = { append: (d: string) => { evidence.push(d); } };
    const rb = new RingBuffer(100);
    const events: Record<string, unknown>[] = [];
    const rd = { detect: () => {}, checkExitCode: () => {} };
    const ag = { feed: () => {} };
    const eb = { emit: (e: Record<string, unknown>) => events.push(e) };
    return { evidence, ew, rb, events, rd, ag, eb };
  }

  it("should write evidence on feedStream", () => {
    const { ew, rb, events, rd, ag, eb } = setup();
    const op = new OutputPipe(ew, rb, rd, ag, eb, "step-1");
    op.feedStream("line1\nline2\n");
    expect(evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("should write evidence on feedExec", () => {
    const { ew, rb, events, rd, ag, eb } = setup();
    rd.checkExitCode = () => {};
    const op = new OutputPipe(ew, rb, rd, ag, eb, "step-1");
    op.feedExec("ok\n", "", 0);
    expect(evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("should emit observation on feedStream after 100 lines", () => {
    const { ew, rb, events, rd, ag, eb } = setup();
    const op = new OutputPipe(ew, rb, rd, ag, eb, "step-1");
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    op.feedStream(lines + "\n");
    const obs = events.filter(e => e.type === "observation");
    expect(obs.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle partial lines in feedStream", () => {
    const { ew, rb, events, rd, ag, eb } = setup();
    const op = new OutputPipe(ew, rb, rd, ag, eb, "step-1");
    op.feedStream("partial line without newline");
    expect(evidence.length).toBe(0); // not flushed yet
    op.feedStream(" rest of line\n");
    expect(evidence.length).toBeGreaterThanOrEqual(1);
  });
});
