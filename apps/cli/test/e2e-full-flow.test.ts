/**
 * End-to-end test: full bootstrap → create run → execute → result.
 * Uses MockProvider — no real API key or hardware needed.
 * Run: pnpm vitest run test/e2e-full-flow.test.ts
 */
import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, ContextAssembler, RunManager, HookManager, StepExecutor, DecisionHandler } from "@embed-agent/runtime";
import { LLMCallManager, MockProvider, Planner, Observer, ReplyGenerator, Memory, SkillRegistry } from "@embed-agent/agent";
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, SkillStore } from "@embed-agent/stores";
import { ConnectionManager, TargetManager, OutputPipe, RingBuffer, RuleDetector, Aggregator, FakeConnection } from "@embed-agent/tools";
import { Views } from "@embed-agent/views";

const DATA_DIR = ".embed-agent-e2e-test";

describe("E2E: create → execute → result", () => {
  it("completes a full validation run with mock LLM and fake connection", async () => {
    // === Setup ===
    const eventStore = new EventStore(DATA_DIR);
    const runStore = new RunStore(DATA_DIR);
    const targetStore = new TargetStore(DATA_DIR);
    const memoryStore = new MemoryStore(DATA_DIR);
    const evidenceStore = new EvidenceStore(DATA_DIR);
    const skillStore = new SkillStore(DATA_DIR);

    await targetStore.add({
      target_id: "e2e-device",
      connections: { local: "available" },
      target_hints: {},
    } as never).catch(() => {});

    const eventBus = new EventBus();
    eventStore.subscribeToBus(eventBus, runStore, evidenceStore);

    // Separate mock providers per role — avoids index interference between Planner/Observer/Reply calls
    const plannerMock = new MockProvider();
    plannerMock.setResponse(JSON.stringify({
      plan_id: "e2e",
      estimated_duration_sec: 30,
      steps: [
        { id: "s1", capability: "local_exec", action: "exec", command: "uname -a", timeout_sec: 15 },
        { id: "s2", capability: "local_exec", action: "exec", command: "echo dmesg", timeout_sec: 15 },
      ],
      evidence_policy: { always: ["serial:full"], on_failure: ["serial:last-window"] },
      success_criteria: ["shell responds", "dmesg works"],
      failure_signals: ["kernel panic"],
    }));

    const observerMock = new MockProvider();
    observerMock.setResponse(JSON.stringify({ decision: "continue", reason: "ok", confidence: 0.9, reasoning_trace: "normal", evidence_refs: [] }));

    const replyMock = new MockProvider();
    replyMock.setResponse(JSON.stringify({
      summary: "Device responded to shell and dmesg showed kernel output. All success criteria met.",
      suggested_next: "run regression test suite",
      key_evidence: [
        { summary: "Shell check passed", evidence_refs: ["serial:full"] },
        { summary: "Dmesg shows kernel messages", evidence_refs: ["dmesg:full"] },
      ],
      criteria_results: [
        { criterion: "shell responds", status: "pass", evidence_refs: ["serial:full"] },
        { criterion: "dmesg works", status: "pass", evidence_refs: ["dmesg:full"] },
      ],
      confidence: 0.95,
    }));

    // Route LLM calls to the right mock by matching system prompt content
    const roleProvider = {
      async call(msgs: { role: string; content: string }[], opts: { model: string; timeout: number; maxTokens: number }) {
        const sys = msgs.find(m => m.role === "system")?.content ?? "";
        if (sys.includes("Embed Agent Task Planner") || sys.includes("embedded device validation agent")) return plannerMock.call(msgs, opts);
        if (sys.includes("Embed Agent Reply Generator") || sys.includes("Reply Generator")) return replyMock.call(msgs, opts);
        return observerMock.call(msgs, opts);
      },
    };

    const llm = new LLMCallManager(roleProvider, {
      planner: { model: "mock", timeout: 30 },
      observer: { model: "mock", timeout: 30 },
      reply: { model: "mock", timeout: 30 },
    });

    const planner = new Planner(llm, { emit: async (e) => { await eventBus.emit(e); } });
    const reply = new ReplyGenerator(llm, eventStore, evidenceStore, runStore,
      memoryStore as never,
      { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } }, DATA_DIR,
    );
    const observerInst = new Observer(llm, new Memory(memoryStore), { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } });
    const skillRegistry = new SkillRegistry(skillStore);

    const cm = new ConnectionManager(
      { emit: async (e) => { await eventBus.emit(e); } }, targetStore,
      { allowed_commands: ["*"] },
    );
    const tm = new TargetManager(cm, targetStore);
    const contextAssembler = new ContextAssembler(runStore, eventStore, targetStore, memoryStore, evidenceStore, skillRegistry);
    const hm = new HookManager([], { emit: async (e) => { await eventBus.emit(e); } });

    const rm = new RunManager(
      runStore, targetStore, tm, eventBus, hm, contextAssembler,
      { call: async (sp: string, fc: string, runId?: string) => planner.call(sp, fc, runId) },
      {
        generate: (rid: string) => reply.generate(rid),
        generateMinimal: (rid: string, reason: string) => reply.generateMinimal(rid, reason),
        generateCancelled: (rid: string, reason: string) => reply.generateCancelled(rid, reason),
      },
      DATA_DIR,
    );

    // Inject executor + DH factories
    rm.setExecutorFactory(async (runId: string, targetId: string) => {
      const target = await targetStore.get(targetId);
      const ag = new Aggregator(eventBus);
      ag.setRunId(runId);

      const pipeFactory = (stepId: string) => {
        const rb = new RingBuffer(200);
        const evidenceSaver = { saveWindow: (rid: string, ref: string, data: string) => evidenceStore.write(rid, ref, data).then(() => {}) };
        const rd = new RuleDetector(rb, eventBus, evidenceSaver, runId);
        const ew = { append: (d: string) => { evidenceStore.write(runId, `step-${stepId}:full`, d).catch(() => {}); } };
        const pipe = new OutputPipe(ew, rb, rd, ag, eventBus, stepId, 60000);
        pipe.setRunId(runId);
        const fc = new FakeConnection();
        fc.execResult = { exit_code: 0, stdout: "Linux e2e 6.1.0\n[0.000000] Booting...\n", stderr: "" };
        pipe.setConnection?.(fc);
        return pipe;
      };

      return new StepExecutor(runId, target ?? { target_id: targetId, connections: {} }, eventBus, hm, cm, pipeFactory, { maxRetries: 0 });
    });

    rm.setDecisionHandlerFactory((runId: string) => {
      return new DecisionHandler(
        eventBus, hm,
        { decide: async (sp: string, fc: string, rid?: string, ts?: string, tt?: string, tsev?: string, cb?: boolean, we?: boolean) => observerInst.decide(sp, fc, rid, ts, tt, tsev, cb, we) },
        {
          pause: (rid, r) => rm.pause(rid, r),
          cancel: (rid, r) => rm.cancel(rid, r),
          stopRun: (rid, r) => rm.stopRun(rid, r),
          appendStep: (rid, s) => rm.appendStep(rid, s),
        },
        {
          assembleObserverContext: async (rid: string, event: Record<string, unknown>, cbActive: boolean, warnEsc: boolean) => {
            const ctx = await contextAssembler.assembleObserverContext(rid, event as never, cbActive, warnEsc);
            const result: { staticPrompt: string; formattedContext: string; knownIssues?: { fact_id: string; category: string; statement: string; extended_pattern?: string }[] } = { staticPrompt: ctx.staticPrompt, formattedContext: ctx.formattedContext };
            if (ctx.knownIssues) result.knownIssues = ctx.knownIssues;
            return result;
          },
        },
      );
    });

    // === Execute ===
    // Create a temp artifact file (preflight checks fs.access)
    const artifactPath = join(tmpdir(), "embed-agent-e2e-test.img");
    await writeFile(artifactPath, "e2e test artifact\n");
    console.log("Artifact created:", artifactPath);
    console.log("Creating run...");
    const createResult = await rm.createRun({
      artifact: { path: artifactPath, type: "firmware" },
      target: "e2e-device",
      expected: "Device boots and responds to shell",
      constraints: { allow_flash: false },
    });

    console.log("Create result:", JSON.stringify(createResult, null, 2));
    if (createResult.status !== "accepted") {
      console.log("FAILED CHECKS:", JSON.stringify(createResult.failed_checks));
      console.log("REASONS:", JSON.stringify(createResult.reasons));
    }
    expect(createResult.status).toBe("accepted");
    expect(createResult.run_id).toBeTruthy();
    const runId = createResult.run_id!;
    console.log(`Run created: ${runId}`);

    // Poll for terminal state (execution is backgrounded)
    let terminal = false;
    for (let i = 0; i < 40; i++) {
      const run = await runStore.get(runId);
      if (!run || ["completed", "failed", "cancelled"].includes(run.state)) {
        console.log(`Terminal state: ${run?.state} (after ${i * 500}ms)`);
        terminal = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(terminal).toBe(true);

    // === Verify result ===
    const views = new Views(runStore, eventStore, evidenceStore, targetStore, memoryStore);
    const result = await views.result(runId);

    console.log(`State: ${result.state}`);
    console.log(`Summary: ${result.summary}`);
    console.log(`Key evidence: ${result.key_evidence?.length ?? 0} items`);
    if (result.criteria_results) {
      console.log(`Criteria: ${result.criteria_results.map(c => `${c.criterion}=${c.status}`).join(", ")}`);
    }

    expect(result.result_available).toBe(true);
    expect(["completed", "failed"]).toContain(result.state);
    expect(result.summary).toBeTruthy();
    expect(result.key_evidence).toBeTruthy();
    expect(result.key_evidence!.length).toBeGreaterThan(0);
  }, 60000);
});
