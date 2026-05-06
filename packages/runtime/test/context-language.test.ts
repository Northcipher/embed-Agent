import { describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/context-assembler.js";
import type { EventRecord, RunRecord } from "@embed-agent/stores";

const run: RunRecord = {
  run_id: "run-lang",
  session_id: "session-lang",
  state: "planning",
  target_id: "board-1",
  artifact: { path: "/tmp/boot.img", type: "firmware" },
  elapsed_sec: 0,
  last_event_seq: 0,
  evidence_root: "/tmp/run-lang",
  created_at: "2026-05-05T00:00:00.000Z",
};

const runStore: ConstructorParameters<typeof ContextAssembler>[0] = {
  async get(): Promise<RunRecord> {
    return run;
  },
};

const targetStore: ConstructorParameters<typeof ContextAssembler>[2] = {
  async get(): Promise<{ target_id: string; connections: Record<string, unknown> }> {
    return { target_id: "board-1", connections: { serial: { port: "/dev/ttyUSB0", baud: 115200 } } };
  },
  async getState(): Promise<{ serial: string; adb: string; state: string }> {
    return { serial: "connected", adb: "offline", state: "idle" };
  },
};

const memory: ConstructorParameters<typeof ContextAssembler>[3] = {
  async listByTarget(): Promise<[]> {
    return [];
  },
  async queryFacts(): Promise<[]> {
    return [];
  },
  async readWorkingMemory(): Promise<[]> {
    return [];
  },
};

describe("ContextAssembler reply language", () => {
  it("adds reply language instructions to planner context", async () => {
    const assembler = new ContextAssembler(runStore, { read: async () => [] }, targetStore, memory);

    const context = await assembler.assemblePlannerContext("run-lang", {
      task: "验证串口启动",
      expected: "串口输出 boot ok",
      reply_language: "zh",
    });

    expect(context.formattedContext).toContain("## Output Language");
    expect(context.formattedContext).toContain("in Chinese");
    expect(context.formattedContext).toContain("commands, paths, target IDs, and evidence refs unchanged");
  });

  it("adds reply language instructions to observer context from run_started", async () => {
    const events: EventRecord[] = [
      {
        seq: 1,
        type: "run_started",
        source: "run_manager",
        summary: "started",
        payload: { task: "serial smoke", expected: "boot ok", reply_language: "zh" },
        time: "2026-05-05T00:00:01.000Z",
        run_id: "run-lang",
      },
    ];
    const eventStore: ConstructorParameters<typeof ContextAssembler>[1] = {
      async read(): Promise<EventRecord[]> {
        return events;
      },
    };
    const assembler = new ContextAssembler(runStore, eventStore, targetStore, memory);

    const context = await assembler.assembleObserverContext("run-lang", events[0]!);

    expect(context.formattedContext).toContain("## Output Language");
    expect(context.formattedContext).toContain("in Chinese");
    expect(context.formattedContext).toContain("event types, rule IDs, commands, target IDs, and evidence refs unchanged");
  });
});
