import { describe, it, expect } from "vitest";
import { StepQueue } from "../src/step-queue.js";
import type { Step } from "@embed-agent/contracts";

function makeStep(id: string): Step {
  return { id, action: "exec", capability: "shell_exec", timeout: 30, condition: "always", on_failure: "stop" };
}

describe("StepQueue", () => {
  it("should load and return steps in order", () => {
    const q = new StepQueue();
    q.load([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
    expect(q.next()?.id).toBe("s1");
    expect(q.next()?.id).toBe("s2");
    expect(q.next()?.id).toBe("s3");
    expect(q.next()).toBeNull();
  });

  it("should append steps", () => {
    const q = new StepQueue();
    q.load([makeStep("s1")]);
    q.next();
    q.append(makeStep("s2"));
    expect(q.next()?.id).toBe("s2");
  });

  it("should clear all steps", () => {
    const q = new StepQueue();
    q.load([makeStep("s1"), makeStep("s2")]);
    q.clear();
    expect(q.isEmpty).toBe(true);
  });

  it("should pause and resume", () => {
    const q = new StepQueue();
    q.load([makeStep("s1"), makeStep("s2")]);
    q.pause();
    expect(q.next()).toBeNull();
    q.resume();
    expect(q.next()?.id).toBe("s1");
  });
});
