import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("should store lines", () => {
    const rb = new RingBuffer(10);
    rb.push("line1");
    rb.push("line2");
    expect(rb.totalPushed()).toBe(2);
  });

  it("should get window around a hit", () => {
    const rb = new RingBuffer(10);
    for (let i = 0; i < 10; i++) rb.push(`line${i}`);
    const window = rb.getWindow(5, 2, 2);
    expect(window).toHaveLength(5);
    expect(window[0]).toBe("line3");
    expect(window[4]).toBe("line7");
  });

  it("should wrap around", () => {
    const rb = new RingBuffer(5);
    for (let i = 0; i < 10; i++) rb.push(`line${i}`);
    expect(rb.totalPushed()).toBe(10);
    const recent = rb.getRecent(3);
    expect(recent).toHaveLength(4); // getRecent(3) gets last 3+1 lines
    expect(recent[0]).toBe("line6");
    expect(recent[3]).toBe("line9");
  });
});
