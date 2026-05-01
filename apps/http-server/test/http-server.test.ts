/**
 * HTTP server integration test — all 6 routes + SSE streaming.
 * Uses mock LLM and fake connections — no real hardware or API keys needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import pkg from "@fastify/sse";
const fastifySSE = (pkg as unknown as { default: unknown }).default ?? pkg;
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus, ContextAssembler, RunManager, HookManager, StepExecutor, DecisionHandler } from "@embed-agent/runtime";
import { LLMCallManager, MockProvider, Planner, Observer, ReplyGenerator, Memory, SkillRegistry } from "@embed-agent/agent";
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, SkillStore } from "@embed-agent/stores";
import { ConnectionManager, TargetManager, OutputPipe, RingBuffer, RuleDetector, Aggregator, FakeConnection } from "@embed-agent/tools";
import { CommandHandler } from "@embed-agent/cli";
import { Views } from "@embed-agent/views";

import { registerRunRoutes } from "../src/routes/runs.js";

const DATA_DIR = ".embed-agent-http-test";

let app: ReturnType<typeof Fastify>;
let handler: CommandHandler;
let runStore: RunStore;
let artifactPath: string;

beforeAll(async () => {
  // === Create the full service graph (same as E2E test) ===
  const eventStore = new EventStore(DATA_DIR);
  runStore = new RunStore(DATA_DIR);
  const targetStore = new TargetStore(DATA_DIR);
  const memoryStore = new MemoryStore(DATA_DIR);
  const evidenceStore = new EvidenceStore(DATA_DIR);
  const skillStore = new SkillStore(DATA_DIR);

  await targetStore.add({
    target_id: "http-test-device",
    connections: { local: "available" },
    target_hints: {},
  } as never).catch(() => {});

  // Create temp artifact file (preflight checks fs.access)
  artifactPath = join(tmpdir(), "embed-agent-http-test.img");
  await writeFile(artifactPath, "http test artifact\n");

  const eventBus = new EventBus();
  eventStore.subscribeToBus(eventBus, runStore, evidenceStore);

  // Mock LLM per role
  const plannerMock = new MockProvider();
  plannerMock.setResponse(JSON.stringify({
    plan_id: "http-e2e",
    estimated_duration_sec: 15,
    steps: [{ id: "s1", capability: "local_exec", action: "exec", command: "echo ok", timeout_sec: 10 }],
    evidence_policy: { always: ["serial:full"], on_failure: ["serial:last-window"] },
    success_criteria: ["command executes"],
    failure_signals: ["panic"],
  }));

  const observerMock = new MockProvider();
  observerMock.setResponse(JSON.stringify({ decision: "continue", reason: "ok", confidence: 0.9, reasoning_trace: "normal", evidence_refs: [] }));

  const replyMock = new MockProvider();
  replyMock.setResponse(JSON.stringify({
    summary: "HTTP test run completed. Device executed command successfully.",
    suggested_next: "run full test suite",
    key_evidence: [{ summary: "Command OK", evidence_refs: ["serial:full"] }],
    criteria_results: [{ criterion: "command executes", status: "pass", evidence_refs: ["serial:full"] }],
    confidence: 0.95,
  }));

  const roleProvider = {
    async call(msgs: { role: string; content: string }[], opts: { model: string; timeout: number; maxTokens: number }) {
      const sys = msgs.find(m => m.role === "system")?.content ?? "";
      if (sys.includes("embedded device validation agent") || sys.includes("Task Planner")) return plannerMock.call(msgs, opts);
      if (sys.includes("Reply Generator")) return replyMock.call(msgs, opts);
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
      fc.execResult = { exit_code: 0, stdout: "ok\n", stderr: "" };
      pipe.setConnection?.(fc);
      return pipe;
    };
    return new StepExecutor(runId, target ?? { target_id: targetId, connections: {} }, eventBus, hm, cm, pipeFactory, { maxRetries: 0 });
  });

  rm.setDecisionHandlerFactory((runId: string) => {
    return new DecisionHandler(
      eventBus, hm,
      { decide: async (sp: string, fc: string, rid?: string, ts?: string, tt?: string, tsev?: string, cb?: boolean, we?: boolean) => observerInst.decide(sp, fc, rid, ts, tt, tsev, cb, we) },
      { pause: (rid, r) => rm.pause(rid, r), cancel: (rid, r) => rm.cancel(rid, r), stopRun: (rid, r) => rm.stopRun(rid, r), appendStep: (rid, s) => rm.appendStep(rid, s) },
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

  const views = new Views(runStore, eventStore, evidenceStore, targetStore, memoryStore);
  handler = new CommandHandler(rm, views, memoryStore, skillStore as never);

  // === Create Fastify app ===
  app = Fastify({ logger: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(fastifySSE as any, { heartbeatInterval: 30000 });
  registerRunRoutes(app, handler);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("HTTP Server", () => {
  let runId: string;

  // --- POST /runs ---
  it("POST /runs — creates a run (flat expected)", async () => {
    const res = await app.inject({
      method: "POST", url: "/runs",
      headers: { "content-type": "application/json" },
      payload: {
        artifact: { path: artifactPath, type: "firmware" },
        target: "http-test-device",
        expected: "device executes command successfully",
        constraints: { allow_flash: false },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("accepted");
    expect(body.run_id).toBeTruthy();
    runId = body.run_id;
  });

  it("POST /runs — creates a run (context.body)", async () => {
    // Wait for first run to release the target
    for (let i = 0; i < 30; i++) {
      const r = await runStore.get(runId);
      if (r && ["completed", "failed", "cancelled"].includes(r.state)) break;
      await new Promise(res => setTimeout(res, 300));
    }
    const res = await app.inject({
      method: "POST", url: "/runs",
      headers: { "content-type": "application/json" },
      payload: {
        artifact: { path: artifactPath, type: "firmware" },
        target: "http-test-device",
        context: { expected: "device boots", concerns: ["stability"], success_criteria: ["boots"] },
        constraints: { allow_flash: false },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");
  });

  it("POST /runs — rejects missing target", async () => {
    const res = await app.inject({
      method: "POST", url: "/runs",
      headers: { "content-type": "application/json" },
      payload: { artifact: { path: "/x", type: "fw" }, target: "", expected: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).not.toBe("accepted");
  });

  // --- GET /runs/:id/status ---
  it("GET /runs/:id/status — returns run state", async () => {
    // Wait for execution to at least start
    await new Promise(r => setTimeout(r, 200));
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run_id).toBe(runId);
    expect(["running", "completed", "planning"]).toContain(body.state);
  });

  // --- GET /runs/:id/events ---
  it("GET /runs/:id/events — returns paginated events", async () => {
    // Wait for run to complete
    for (let i = 0; i < 30; i++) {
      const r = await runStore.get(runId);
      if (r && ["completed", "failed"].includes(r.state)) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/events?after_seq=0&limit=10` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toBeTruthy();
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0].seq).toBeGreaterThanOrEqual(0);
  });

  // --- GET /runs/:id/events?types= ---
  it("GET /runs/:id/events?types= — filters by event type", async () => {
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/events?types=run_started,run_completed` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const e of body.events) {
      expect(["run_started", "run_completed"]).toContain(e.type);
    }
  });

  // --- GET /runs/:id/result ---
  it("GET /runs/:id/result — returns verdict and criteria", async () => {
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/result` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result_available).toBe(true);
    expect(body.summary).toBeTruthy();
    console.log(`Result: state=${body.state} summary="${body.summary}"`);
    if (body.criteria_results) {
      console.log(`Criteria: ${body.criteria_results.map((c: { criterion: string; status: string }) => `${c.criterion}=${c.status}`)}`);
    }
  });

  // --- GET /runs/:id/evidence ---
  it("GET /runs/:id/evidence — returns evidence index or content", async () => {
    const res = await app.inject({ method: "GET", url: `/runs/${runId}/evidence` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBeDefined();
  });
});

// --- SSE stream test (needs real listen + fetch) ---
describe("SSE Stream", () => {
  it("streams events via SSE", async () => {
    // Create a new run to stream
    const createRes = await app.inject({
      method: "POST", url: "/runs",
      headers: { "content-type": "application/json" },
      payload: {
        artifact: { path: artifactPath, type: "firmware" },
        target: "http-test-device",
        expected: "SSE stream test",
        constraints: { allow_flash: false },
      },
    });
    const sseRunId = createRes.json().run_id;

    // Use app.inject with special handling — fastify inject doesn't support streaming well
    // Start a real listener for SSE testing
    const port = 18787; // fixed test port
    await app.listen({ host: "127.0.0.1", port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/runs/${sseRunId}/events/stream?after_seq=0`, {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.timeout(8000),
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      // Wait for setInterval to fire first poll (1000ms interval + buffer)
      await new Promise(r => setTimeout(r, 1500));

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const sseEvents: string[] = [];
      const deadline = Date.now() + 7000;

      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        console.log("SSE raw chunk:", JSON.stringify(text.slice(0, 200)));
        // SSE events are separated by \n\n
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim()) {
            const m = part.match(/^event: (\S+)/m);
            if (m) sseEvents.push(m[1]!);
          }
        }
        if (sseEvents.length >= 3) break;
      }
      reader.cancel();

      console.log(`SSE events received (${sseEvents.length}): ${sseEvents.join(", ")}`);
      expect(sseEvents.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      // Re-create app for subsequent tests if needed (not in this suite)
    }
  }, 15000);
});
