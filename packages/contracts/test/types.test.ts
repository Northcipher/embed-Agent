import { describe, it, expect } from "vitest";
import type { Connection, ExecResult } from "../src/connection.js";
import type { SemanticFact, RunProfile } from "../src/memory.js";
import type { Skill, SkillSummary } from "../src/skill.js";
import { HOOK_POINTS } from "../src/hook.js";
import type { HookPoint } from "../src/hook.js";
import { ERROR_CODES } from "../src/error.js";
import type { ErrorCode } from "../src/error.js";
import type { Task } from "../src/task.js";

describe("Connection", () => {
  it("ExecResult should have stdout/stderr/exit_code", () => {
    const r: ExecResult = { stdout: "ok", stderr: "", exit_code: 0 };
    expect(r.exit_code).toBe(0);
  });
});

describe("Memory", () => {
  it("SemanticFact should support all categories", () => {
    const fact: SemanticFact = {
      fact_id: "f-1",
      scope: "target",
      scope_id: "board-01",
      category: "known_issue",
      statement: "foo error is harmless",
      source: "auto",
      evidence_refs: [],
      verified: false,
      created_at: "2026-04-29T00:00:00Z",
    };
    expect(fact.category).toBe("known_issue");
  });

  it("RunProfile should have stage_durations and final_metrics", () => {
    const profile: RunProfile = {
      run_id: "run-001",
      target_id: "board-01",
      artifact: { path: "/boot.img", type: "firmware_img" },
      result: "completed",
      stage_durations: [{ stage: "kernel", duration: 12.8 }],
      final_metrics: { memory_mb: 120 },
      output_summary: {
        total_lines: 12000,
        peak_lines_per_sec: 500,
        silence_count: 0,
        rule_hits: {},
      },
      recorded_at: "2026-04-29T00:00:00Z",
    };
    expect(profile.result).toBe("completed");
  });
});

describe("Skill", () => {
  it("SkillSummary should be a subset of Skill", () => {
    const summary: SkillSummary = {
      name: "validate-boot",
      category: "boot",
      description: "Validate boot process",
    };
    expect(summary.name).toBe("validate-boot");
  });
});

describe("Hook", () => {
  it("HOOK_POINTS should have 8 points", () => {
    expect(HOOK_POINTS).toHaveLength(8);
  });
});

describe("ErrorCode", () => {
  it("ERROR_CODES should have 10 codes", () => {
    expect(ERROR_CODES).toHaveLength(10);
  });

  it("should include all defined codes", () => {
    expect(ERROR_CODES).toContain("invalid_request");
    expect(ERROR_CODES).toContain("internal_error");
    expect(ERROR_CODES).toContain("target_busy");
    expect(ERROR_CODES).toContain("target_not_ready");
  });
});

describe("Task", () => {
  it("should support cron trigger", () => {
    const task: Task = {
      task_id: "task-1",
      name: "nightly-boot",
      trigger: { type: "cron", cron: "0 2 * * *" },
      skill: "validate-boot",
      params: {},
      enabled: true,
      created_at: "2026-04-29T00:00:00Z",
      updated_at: "2026-04-29T00:00:00Z",
    };
    expect(task.trigger.type).toBe("cron");
  });
});
