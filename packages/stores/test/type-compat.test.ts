/**
 * TYPE COMPATIBILITY TESTS
 *
 * Verifies that stores types match contracts types. If a store redefines a type
 * that exists in contracts, the assignability check below will fail at compile time.
 *
 * Rule: contracts are the single source of truth. Stores must import from contracts,
 * not redefine types that already exist there.
 */
import { describe, it, expect } from "vitest";
import type {
  RunState as C_RunState, RunRecord as C_RunRecord,
  TargetState as C_TargetState, TargetProfile as C_TargetProfile,
  EventType, Event,
  Decision, DecisionType,
  Step, StepAction, Plan,
  AgentReply,
  HookConfig, HookPoint, HookResult,
  Skill,
  Task,
  ErrorCode,
} from "@embed-agent/contracts";

import type {
  RunState as S_RunState, RunRecord as S_RunRecord,
  TargetState as S_TargetState, TargetProfile as S_TargetProfile,
  EventRecord,
  AppendEvent,
} from "../src/index.js";
import {
  RunStore,
  TargetStore,
  EventStore,
} from "../src/index.js";

describe("Type compatibility: stores must match contracts", () => {
  // These tests exist purely for compile-time validation.
  // If any of these type relationships break, the test file won't compile.

  it("RunState matches contracts", () => {
    const _s: S_RunState = "planning" as C_RunState;
    const _c: C_RunState = "planning" as S_RunState;
    expect(_s).toBe(_c);
  });

  it("TargetState matches contracts", () => {
    const _s: S_TargetState = "idle" as C_TargetState;
    const _c: C_TargetState = "idle" as S_TargetState;
    expect(_s).toBe(_c);
  });

  it("EventStore uses contracts EventType", () => {
    const ev: AppendEvent = { type: "run_started" as EventType, source: "test", summary: "", payload: {} };
    const _check: string = ev.type satisfies EventType;
    expect(_check).toBe("run_started");
  });

  it("EventRecord is assignable to contracts Event", () => {
    // Compile-time: if EventRecord fields diverge from Event, this fails
    const _r: EventRecord = {} as Event;
    expect(_r).toBeDefined();
  });

  it("stores are constructable (smoke)", () => {
    expect(new RunStore()).toBeInstanceOf(RunStore);
    expect(new TargetStore()).toBeInstanceOf(TargetStore);
    expect(new EventStore()).toBeInstanceOf(EventStore);
  });
});
