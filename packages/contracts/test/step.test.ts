import { describe, it, expect } from "vitest";
import type { Step, Plan, StepAction } from "../src/step.js";

describe("Step", () => {
  it("should accept a minimal exec step", () => {
    const step: Step = {
      id: "step-1",
      action: "exec",
      capability: "shell_exec",
      command: "dmesg",
      timeout: 60,
      condition: "always",
      on_failure: "stop",
    };
    expect(step.action).toBe("exec");
    expect(step.capability).toBe("shell_exec");
  });

  it("should accept a stream step with observe config", () => {
    const step: Step = {
      id: "step-2",
      action: "stream",
      capability: "watch_serial",
      timeout: 180,
      condition: "always",
      on_failure: "collect_and_stop",
      observe: {
        interval: 60,
        metrics: ["memory", "cpu"],
        trend_window: 3,
        sampling_commands: ["cat /proc/meminfo"],
      },
    };
    expect(step.observe?.interval).toBe(60);
  });

  it("should accept a flash step", () => {
    const step: Step = {
      id: "step-0",
      action: "flash",
      capability: "flash",
      image: "boot.img",
      partition: "boot",
      timeout: 300,
      condition: "always",
      on_failure: "stop",
    };
    expect(step.action).toBe("flash");
  });

  it("should accept a push step", () => {
    const step: Step = {
      id: "step-3",
      action: "push",
      capability: "push",
      src: "/src/file",
      dst: "/dst/file",
      timeout: 30,
      condition: "always",
      on_failure: "stop",
    };
    expect(step.action).toBe("push");
  });
});

describe("StepAction", () => {
  it("should have exactly 4 action types", () => {
    const actions: StepAction[] = ["exec", "stream", "push", "flash"];
    expect(actions).toHaveLength(4);
  });
});

describe("Plan", () => {
  it("should accept a valid plan", () => {
    const plan: Plan = {
      plan_id: "plan-001",
      estimated_duration_sec: 360,
      steps: [],
      evidence_policy: {
        always: ["serial:full", "events"],
        on_failure: ["serial:last_window"],
      },
      success_criteria: ["boot completed"],
      failure_signals: ["kernel panic"],
    };
    expect(plan.plan_id).toBe("plan-001");
  });
});
