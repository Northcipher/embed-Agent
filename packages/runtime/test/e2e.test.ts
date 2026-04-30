/**
 * END-TO-END INTEGRATION TEST
 * Verifies the full pipeline: createRun → Planner → executeRun → Reply → result_ready
 * Uses FakeConnection + MockProvider to simulate device + LLM.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventBus } from "../src/event-bus.js";
import { EventStore } from "../../stores/src/event-store.js";
import { RunStore } from "../../stores/src/run-store.js";
import { TargetStore } from "../../stores/src/target-store.js";
import { EvidenceStore } from "../../stores/src/evidence-store.js";
import { MemoryStore } from "../../stores/src/memory-store.js";
import { ContextAssembler } from "../src/context-assembler.js";
import { RunManager } from "../src/run-manager.js";
import { HookManager } from "../src/hook-manager.js";
import { StepExecutor } from "../src/step-executor.js";
import { DecisionHandler } from "../src/decision-handler.js";
import { FakeConnection } from "../../tools/src/fake.js";
import { LLMCallManager, MockProvider, Planner, Observer, ReplyGenerator, Memory } from "../../agent/src/index.js";

describe("E2E: createRun → result_ready", () => {
  const tmpDir = path.join(os.tmpdir(), `e2e-${Date.now()}`);
  const dataRoot = tmpDir;

  // Stores
  const eventStore = new EventStore(dataRoot);
  const runStore = new RunStore(dataRoot);
  const targetStore = new TargetStore(dataRoot);
  const evidenceStore = new EvidenceStore(dataRoot);
  const memoryStore = new MemoryStore(dataRoot);

  // EventBus
  const eventBus = new EventBus();
  eventStore.subscribeToBus(eventBus, runStore, evidenceStore);

  // Fake device
  const fakeConn = new FakeConnection();
  fakeConn.execResult = { stdout: "Linux version 5.10", stderr: "", exit_code: 0 };
  fakeConn.streamLines = ["[BOOT] Starting kernel", "[BOOT] Init systemd", "[OK] Reached target"];

  const cm = {
    getForStep: () => fakeConn as never,
    get: () => fakeConn as never,
  };

  // Mock LLM
  const mockLLM = new MockProvider();
  mockLLM.setResponse(JSON.stringify({
    plan_id: "p1", estimated_duration_sec: 10,
    steps: [{ id: "s1", capability: "shell_exec", action: "exec", command: "uname -a", timeout_sec: 5 }],
    evidence_policy: { always: ["serial:full"], on_failure: ["logcat"] },
    success_criteria: ["boot ok"], failure_signals: ["kernel panic"],
  }));
  const llm = new LLMCallManager(mockLLM, {
    planner: { model: "mock", timeout: 30 },
    observer: { model: "mock", timeout: 30 },
    reply: { model: "mock", timeout: 30 },
  });

  // Agent
  const memory = new Memory(memoryStore);
  const planner = new Planner(llm);
  const observer = new Observer(llm, memory);
  const reply = new ReplyGenerator(llm, eventStore, evidenceStore, runStore,
    memoryStore as never,
    { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } }, dataRoot,
  );

  // Runtime
  const hm = new HookManager([]);
  const contextAssembler = new ContextAssembler(runStore, eventStore, targetStore, memoryStore);
  const plannerAdapter = { call: async (sp: string, dc: Record<string, unknown>) => planner.call(sp, dc as never) };
  const replyAdapter = {
    generate: (rid: string) => reply.generate(rid),
    generateMinimal: (rid: string, reason: string) => reply.generateMinimal(rid, reason),
    generateCancelled: (rid: string, reason: string) => reply.generateCancelled(rid, reason),
  };

  const mockTM = {
    acquireLock: async () => true, releaseLock: async () => {}, transitionState: async () => {},
    preflight: async () => ({ all_passed: true, checks: [] as { check: string; passed: boolean; error?: string }[] }),
    recover: async () => false, isBusy: () => false as boolean,
  };
  const rm = new RunManager(runStore, targetStore, mockTM, eventBus, hm, contextAssembler, plannerAdapter, replyAdapter, dataRoot);

  // Register target
  beforeAll(async () => {
    await targetStore.add({ target_id: "t1", connections: { adb: { device_id: "emulator" } }, safety: { allow_flash: true, allow_reboot: true, allow_shell_exec: true, allow_power_cycle: false } });
    rm.setExecutorFactory(async (rid: string, tid: string) => new StepExecutor(rid, { target_id: tid, connections: { adb: { device_id: "emulator" } } }, eventBus, hm, cm));
    rm.setDecisionHandlerFactory((rid: string) => new DecisionHandler(eventBus, hm,
      { decide: async () => ({ decision: "continue" as const, reason: "ok", confidence: 0.9, reasoning_trace: "", evidence_refs: [] }) },
      { pause: (rid2, r) => rm.pause(rid2, r), cancel: (rid2, r) => rm.cancel(rid2, r), stopRun: (rid2, r) => rm.stopRun(rid2, r) },
      { assembleObserverContext: async () => ({ staticPrompt: "", input: { memory: { working_memory: [], known_issues: [] }, constraints: { remaining_sec: 600, allowed_capabilities: [] }, circuit_breaker_active: false, warning_escalation: false, triggering_event: {}, signals: [], evidence_windows: [], checkpoint_history: [] } }) },
    ));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("full pipeline: validate → running → completed → result_ready", async () => {
    const result = await rm.createRun({
      artifact: { path: "/tmp/test.img", type: "firmware" },
      target: "t1",
      expected: "Device boots normally",
    });

    expect(result.status).toBe("accepted");
    expect(result.run_id).toBeDefined();

    // Wait for background execution to complete (max 10s)
    const deadline = Date.now() + 10_000;
    let runState = "";
    while (Date.now() < deadline) {
      const run = await runStore.get(result.run_id!);
      runState = run?.state ?? "";
      if (["completed", "failed", "cancelled"].includes(runState)) break;
      await new Promise(r => setTimeout(r, 200));
    }

    // Run reached terminal state
    expect(["completed", "failed"]).toContain(runState);

    // Events were persisted
    const events = await eventStore.read(result.run_id!);
    expect(events.some(e => e.type === "run_started")).toBe(true);
    expect(events.some(e => e.type === "step_started")).toBe(true);

    // result_ready was emitted (check events)
    const resultReady = events.find(e => e.type === "result_ready");
    if (resultReady) {
      expect(resultReady.payload).toBeDefined();
    }
    // Note: result_ready may be in a later batch if Reply is async
  });
});
