import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import pkg from "@fastify/sse";
import { registerRunRoutes } from "../src/routes/runs.js";

const fastifySSE = (pkg as unknown as { default: unknown }).default ?? pkg;

describe("HTTP routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.map(app => app.close()));
    apps.length = 0;
  });

  async function createApp(overrides: Record<string, unknown> = {}) {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(fastifySSE as never, { heartbeatInterval: 30_000 });

    const handler = {
      targetList: async () => [
        { target_id: "board-01", state: "idle", serial: "connected", adb: "online", fastboot: "disconnected" },
      ],
      getTargetCapabilities: async (targetId: string) => ({
        target: targetId,
        runtime_state: { state: "idle", serial: "connected", adb: "online", fastboot: "disconnected" },
        capabilities: ["serial_output", "shell_exec"],
      }),
      history: async () => [],
      validate: async () => ({ status: "accepted", run_id: "run-1" }),
      pause: async (runId: string, reason: string) => ({ accepted: true, run_id: runId, reason }),
      resume: async (runId: string) => ({ accepted: true, run_id: runId }),
      cancel: async (runId: string, reason: string) => ({ accepted: true, run_id: runId, status: "cancelling", reason }),
      addInstruction: async (runId: string, instruction: string) => ({ accepted: true, run_id: runId, instruction }),
      ignoreRule: async (runId: string, ruleId: string) => ({ accepted: true, run_id: runId, rule_id: ruleId }),
      override: async (runId: string, decision: string) => ({ accepted: true, run_id: runId, action: decision }),
      status: async () => null,
      events: async () => ({ events: [], next_after_seq: 0, has_more: false }),
      result: async () => ({ run_id: "run-1", state: "running", result_available: false }),
      evidence: async () => ({ available: false }),
      ...overrides,
    };

    registerRunRoutes(app, handler as never);
    await app.ready();
    return app;
  }

  it("GET /targets exposes runtime targets", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/targets" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { target_id: "board-01", state: "idle", serial: "connected", adb: "online", fastboot: "disconnected" },
    ]);
  });

  it("POST /runs/:runId/interventions routes control actions to the shared runtime handler", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST",
      url: "/runs/run-1/interventions",
      headers: { "content-type": "application/json" },
      payload: { action: "pause", reason: "operator requested" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, run_id: "run-1", reason: "operator requested" });
  });
});
