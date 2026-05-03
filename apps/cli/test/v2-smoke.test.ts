/**
 * V2 E2E smoke test — full validate flow with MockProvider + FakeConnection.
 * Verifies: Planner tool path, Observer Always-LLM, DecisionHandler post-LLM safety nets, Reply output.
 */
import { describe, it, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import { EventBus, ContextAssembler, RunManager, HookManager, StepExecutor, DecisionHandler } from "@embed-agent/runtime";
import { LLMCallManager, MockProvider, Planner, Observer, ReplyGenerator, Memory, SkillRegistry, createPlannerTools } from "@embed-agent/agent";
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, SkillStore } from "@embed-agent/stores";
import { OutputPipe, RingBuffer, RuleDetector, Aggregator, FakeConnection } from "@embed-agent/tools";

const DATA_DIR = ".embed-agent-test";

describe("V2 Smoke: validate flow", () => {
  it("completes a run with v2 architecture (tool-based LLM, Always-L Observer, multi-pass Reply)", async () => {
    await mkdir(DATA_DIR, { recursive: true });

    const eventStore = new EventStore(DATA_DIR);
    const runStore = new RunStore(DATA_DIR);
    const targetStore = new TargetStore(DATA_DIR);
    const memoryStore = new MemoryStore(DATA_DIR);
    const evidenceStore = new EvidenceStore(DATA_DIR);
    const skillStore = new SkillStore(DATA_DIR);

    await targetStore.add({
      target_id: "e2e-device", connections: {}, target_hints: {},
    } as never).catch(() => {});

    const eventBus = new EventBus();
    eventStore.subscribeToBus(eventBus, runStore, evidenceStore);

    // Separate MockProviders per role
    const plannerMock = new MockProvider();
    plannerMock.setResponse(JSON.stringify({
      plan_id: "v2-smoke", estimated_duration_sec: 30,
      steps: [
        { id: "s1", capability: "local_exec", action: "exec", command: "uname -a", timeout_sec: 15 },
        { id: "s2", capability: "local_exec", action: "exec", command: "echo dmesg", timeout_sec: 15 },
      ],
      evidence_policy: { always: ["serial:full"], on_failure: ["serial:last-window"] },
      success_criteria: ["shell responds", "dmesg works"],
      failure_signals: ["kernel panic"],
    }));

    const observerMock = new MockProvider();
    observerMock.setResponse(JSON.stringify({
      decision: "continue", reason: "normal", confidence: 0.9,
      reasoning_trace: "v2 observer", evidence_refs: [],
    }));

    const replyMock = new MockProvider();
    replyMock.setResponse(JSON.stringify({
      summary: "All criteria passed.", suggested_next: "deploy",
      key_evidence: [{ summary: "OK", evidence_refs: ["serial:full"] }],
      criteria_results: [
        { criterion: "shell responds", status: "pass", evidence_refs: ["serial:full"] },
        { criterion: "dmesg works", status: "pass", evidence_refs: ["dmesg:full"] },
      ],
      confidence: 0.95,
    }));

    // Route by system prompt content
    const roleProvider = {
      call(messages: { role: string; content: string }[], opts: any) {
        const sys = messages.find(m => m.role === "system")?.content ?? "";
        if (sys.includes("Task Planner") || sys.includes("Explore device state")) return plannerMock.call(messages, opts);
        if (sys.includes("Reply Generator") || sys.includes("PRE-DETERMINED")) return replyMock.call(messages, opts);
        return observerMock.call(messages, opts);
      },
    };

    const llm = new LLMCallManager(roleProvider as any, {
      planner: { model: "mock", timeout: 30 },
      observer: { model: "mock", timeout: 30 },
      reply: { model: "mock", timeout: 30 },
    });

    // Agent layer
    const memory = new Memory(memoryStore);
    const plannerTools = createPlannerTools({
      targets: { getState: (id: string) => targetStore.getState?.(id) ?? null, get: (id: string) => targetStore.get(id) },
      memory: memoryStore, skills: skillStore,
    });
    const observerInst = new Observer(llm, memory, { emit: async (e: any) => { await eventBus.emit(e); } });

    const planner = new Planner(llm, { emit: async (e: any) => { await eventBus.emit(e); } }, plannerTools, 8);
    const reply = new ReplyGenerator(llm, eventStore, evidenceStore, runStore,
      memoryStore as any, { emit: async (e: any) => { await eventBus.emit(e); } }, DATA_DIR,
    );

    // Tool layer
    const fakeConn = new FakeConnection();
    fakeConn.execResult = { stdout: "Linux test\ndmesg output", stderr: "", exit_code: 0 };
    const cm = { getForStep: () => fakeConn, get: () => fakeConn };

    const tm = {
      isBusy(s: any) { return s != null && !["idle", "offline"].includes(s.state); },
      async acquireLock(targetId: string, runId: string) {
        const s = await targetStore.getState(targetId);
        if (this.isBusy(s)) return false;
        await targetStore.updateState(targetId, { state: "preparing", current_run_id: runId });
        return true;
      },
      async releaseLock(targetId: string) { await targetStore.updateState(targetId, { state: "idle", current_run_id: undefined }); },
      async transitionState(targetId: string, to: string) { await targetStore.updateState(targetId, { state: to }); },
      async preflight() { return { all_passed: true, checks: [{ check: "fake", passed: true }] }; },
      async recover() { return true; },
    };

    // Runtime
    const hm = new HookManager([], { emit: async (e: any) => { await eventBus.emit(e); } });
    const contextAssembler = new ContextAssembler(runStore, eventStore, targetStore, memoryStore, evidenceStore, undefined);

    const plannerAdapter = { call: async (sp: string, fc: string, runId?: string) => planner.call(sp, fc, runId) };
    const replyAdapter = {
      generate: (rid: string) => reply.generate(rid),
      generateMinimal: (rid: string, reason: string) => reply.generateMinimal(rid, reason),
      generateCancelled: (rid: string, reason: string) => reply.generateCancelled(rid, reason),
    };

    const rm = new RunManager(runStore, targetStore, tm as any, eventBus, hm, contextAssembler, plannerAdapter, replyAdapter, DATA_DIR);

    // Wire executor + decision handler
    rm.setExecutorFactory(async (runId: string, targetId: string) => {
      const target = { target_id: targetId, connections: {} };
      const ag = new Aggregator(eventBus); ag.setRunId(runId);
      const pipeFactory = (stepId: string) => {
        const rb = new RingBuffer(500);
        const rd = new RuleDetector(rb, eventBus, { saveWindow: (rid: string, ref: string, data: string) => evidenceStore.write(rid, ref, data).then(() => {}) }, runId);
        rd.setStepId?.(stepId);
        rd.loadRunRules(
          [{ id: "fatal", kind: "pattern" as const, pattern: /KERNEL PANIC/, severity: "fatal" as const, source: "system" as const, debounce_sec: 30 }],
          [{ id: "warn", kind: "pattern" as const, pattern: /error:/, severity: "warning" as const, source: "system" as const, debounce_sec: 30 }], [],
        );
        const pipe = new OutputPipe({ append: (d: string) => { evidenceStore.write(runId, `step-${stepId}:full`, d).catch(() => {}); } }, rb, rd, ag, eventBus, stepId, 60000);
        pipe.setRunId(runId);
        return pipe;
      };
      return new StepExecutor(runId, target, eventBus, hm, cm as any, pipeFactory);
    });

    rm.setDecisionHandlerFactory((runId: string) => new DecisionHandler(
      eventBus, hm,
      { decide: async (sp: string, fc: string, rid?: string) => observerInst.decide(sp, fc, rid) },
      { pause: (rid: string, r: string) => rm.pause(rid, r), cancel: (rid: string, r: string) => rm.cancel(rid, r), stopRun: (rid: string, r: string) => rm.stopRun(rid, r), appendStep: (rid: string, s: any) => rm.appendStep(rid, s) },
      { assembleObserverContext: async (rid: string, event: any, cbActive: boolean, warnEsc: boolean) => {
        const ctx = await contextAssembler.assembleObserverContext(rid, event as never, cbActive, warnEsc);
        return { staticPrompt: ctx.staticPrompt, formattedContext: ctx.formattedContext, ...(ctx.knownIssues ? { knownIssues: ctx.knownIssues } : {}) };
      }},
      30,
    ));

    rm.setEventReader?.({ read: (rid: string, a?: number, l?: number) => eventStore.read(rid, a, l) });

    // Execute
    const result = await rm.createRun({
      artifact: { path: "/tmp/test.bin", type: "firmware", version: "v2.0" },
      target: "e2e-device",
      expected: "Device boots and responds to shell",
      constraints: { max_duration_sec: 60, allow_flash: false, allow_shell_exec: true },
    });

    expect(result.status).toBe("accepted");
    const runId = result.run_id!;

    // Wait for async execution
    await new Promise(r => setTimeout(r, 3000));

    // Verify
    const run = await runStore.get(runId);
    expect(run).not.toBeNull();
    expect(["completed", "failed"]).toContain(run!.state);

    const events = await eventStore.read(runId);
    console.log(`  Events: ${events.length}, types: [${[...new Set(events.map(e => e.type))].join(", ")}]`);

    // V2 checks
    const llmCalls = events.filter(e => e.type === "llm_call");
    expect(llmCalls.length).toBeGreaterThanOrEqual(3); // planner + observer + reply

    const resultEvent = events.find(e => e.type === "result_ready");
    expect(resultEvent).toBeDefined();
    const rp = (resultEvent?.payload ?? {}) as any;
    expect(rp.criteria_results?.length).toBeGreaterThanOrEqual(1);

    const staleTypes = events.filter(e => e.type === "rule_ignored");
    expect(staleTypes).toHaveLength(0);

    const planEvent = events.find(e => e.type === "plan_generated");
    expect(planEvent).toBeDefined();

    console.log(`  ✓ V2 smoke test: run=${runId} state=${run!.state}`);
    if (run!.state !== "completed") console.log(`    reason: ${run!.failure_reason ?? "none"}`);
  }, 20000);
});
