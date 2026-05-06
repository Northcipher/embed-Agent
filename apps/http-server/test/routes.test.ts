import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import pkg from "@fastify/sse";
import { registerRunRoutes } from "../src/routes/runs.js";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const fastifySSE = (pkg as unknown as { default: unknown }).default ?? pkg;

describe("HTTP routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const oldDataRoot = process.env["EMBED_AGENT_DATA"];
  let currentConfigDir = "";

  afterEach(async () => {
    await Promise.all(apps.map(app => app.close()));
    apps.length = 0;
    if (oldDataRoot === undefined) delete process.env["EMBED_AGENT_DATA"];
    else process.env["EMBED_AGENT_DATA"] = oldDataRoot;
  });

  async function createApp(overrides: Record<string, unknown> = {}) {
    const configDir = await mkdtemp(join(tmpdir(), "embed-agent-routes-"));
    currentConfigDir = configDir;
    process.env["EMBED_AGENT_DATA"] = configDir;
    await writeFile(join(configDir, "system.yml"), "runtime: {}\n");
    await writeFile(join(configDir, "llm.yml"), [
      "default_provider: mock",
      "providers:",
      "  mock:",
      "    type: mock",
      "    api_key_env: MOCK_API_KEY",
      "    models:",
      "      planner: mock",
      "      observer: mock",
      "      reply: mock",
      "",
    ].join("\n"));

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

  it("GET /health/full reports service, config, credentials, and target health", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/health/full" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    expect(res.json().checks.map((c: { name: string }) => c.name)).toContain("llm_credentials");
  });

  it("POST /runs/preflight checks target, capabilities, artifact, and safety constraints", async () => {
    const artifactPath = join(tmpdir(), "embed-agent-preflight.bin");
    await writeFile(artifactPath, "ok");
    const app = await createApp();
    const res = await app.inject({
      method: "POST",
      url: "/runs/preflight",
      headers: { "content-type": "application/json" },
      payload: {
        artifact: { path: artifactPath, type: "firmware" },
        target: "board-01",
        constraints: { allow_flash: false, no_flash: true, allow_shell_exec: true },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
    expect(res.json().checks.map((c: { name: string }) => c.name)).toEqual(["target", "capabilities", "artifact", "safety"]);
  });

  it("PUT /config/llm.yml preserves an existing inline API key when form data omits it", async () => {
    const app = await createApp();
    await writeFile(join(currentConfigDir, "llm.yml"), [
      "default_provider: openai",
      "providers:",
      "  openai:",
      "    type: openai",
      "    api_key_env: OPENAI_API_KEY",
      "    api_key: sk-existing",
      "    models:",
      "      planner: gpt-5.2",
      "      observer: gpt-5.2",
      "      reply: gpt-5.2",
      "",
    ].join("\n"));

    const res = await app.inject({
      method: "PUT",
      url: "/config/llm.yml",
      headers: { "content-type": "application/json" },
      payload: {
        data: {
          default_provider: "openai",
          providers: {
            openai: {
              type: "openai",
              api_key_env: "OPENAI_API_KEY",
              models: { planner: "gpt-5.3", observer: "gpt-5.3", reply: "gpt-5.3" },
            },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const saved = parse(await readFile(join(currentConfigDir, "llm.yml"), "utf-8"));
    expect(saved.providers.openai.api_key).toBe("sk-existing");
    expect(saved.providers.openai.models.planner).toBe("gpt-5.3");
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

  it("POST /tasks creates an automation task and GET /tasks lists it", async () => {
    const app = await createApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { "content-type": "application/json" },
      payload: {
        name: "s820-nightly-boot-validation",
        validation_spec: {
          target: "board-01",
          artifact: { path: "/builds/s820/nightly/boot.img", type: "firmware" },
          expected: "boot ok",
          constraints: { no_flash: true, allow_shell_exec: true },
        },
        trigger: { kind: "cron", cron: "30 2 * * 1-5", timezone: "Asia/Shanghai" },
        policy: { overlap: "skip_if_target_busy", failure: "notify_and_keep_enabled" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "created",
      task: {
        name: "s820-nightly-boot-validation",
        enabled: true,
        validation_spec: { target: "board-01", expected: "boot ok" },
        trigger: { kind: "cron", cron: "30 2 * * 1-5" },
      },
    });

    const list = await app.inject({ method: "GET", url: "/tasks" });
    expect(list.statusCode).toBe(200);
    expect(list.json().tasks).toHaveLength(1);
    expect(list.json().tasks[0].policy.overlap).toBe("skip_if_target_busy");
  });

  it("PATCH /tasks/:name updates automation policy without replacing validation spec", async () => {
    const app = await createApp();
    await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { "content-type": "application/json" },
      payload: {
        name: "nightly",
        validation_spec: {
          target: "board-01",
          artifact: { path: "/builds/s820/nightly/boot.img", type: "firmware" },
          expected: "boot ok",
        },
        trigger: { kind: "cron", cron: "30 2 * * 1-5" },
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/tasks/nightly",
      headers: { "content-type": "application/json" },
      payload: {
        enabled: false,
        policy: { overlap: "queue_next_run", failure: "pause_after_3_failures" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      task: {
        name: "nightly",
        enabled: false,
        validation_spec: { target: "board-01", expected: "boot ok" },
        policy: { overlap: "queue_next_run", failure: "pause_after_3_failures" },
      },
    });
  });

  it("POST /tasks/:name/run starts a run using the saved validation spec", async () => {
    let captured: unknown = null;
    const app = await createApp({
      validate: async (body: unknown) => {
        captured = body;
        return { status: "accepted", run_id: "run-from-task" };
      },
    });
    await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { "content-type": "application/json" },
      payload: {
        name: "nightly",
        validation_spec: {
          target: "board-01",
          artifact: { path: "/builds/s820/nightly/boot.img", type: "firmware" },
          expected: "boot ok",
          constraints: { no_flash: true },
        },
        trigger: { kind: "cron", cron: "30 2 * * 1-5" },
      },
    });

    const res = await app.inject({ method: "POST", url: "/tasks/nightly/run" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "accepted", run_id: "run-from-task" });
    expect(captured).toMatchObject({
      artifact: { path: "/builds/s820/nightly/boot.img", type: "firmware" },
      target: "board-01",
      expected: "boot ok",
      task: "nightly",
      source: { kind: "task", task_name: "nightly" },
      constraints: { no_flash: true },
    });
  });

  it("POST /targets creates a target profile in the runtime target store", async () => {
    const app = await createApp({
      targetList: async () => [
        { target_id: "board-01", state: "idle", serial: "connected", adb: "online", fastboot: "disconnected" },
        { target_id: "lab-adb-01", state: "idle", serial: "disconnected", adb: "disconnected", fastboot: "disconnected" },
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: "/targets",
      headers: { "content-type": "application/json" },
      payload: {
        target_id: "lab-adb-01",
        display_name: "Lab ADB Board 01",
        connections: { adb: { device_id: "ABC123" } },
        safety: { allow_flash: false, allow_reboot: true, allow_shell_exec: true, allow_power_cycle: false },
        target_hints: { boot_markers: ["Booting", "login:"] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "created",
      target: { target_id: "lab-adb-01", connections: { adb: { device_id: "ABC123" } } },
    });
  });

  it("DELETE /targets/:targetId deletes an idle target profile", async () => {
    const app = await createApp();
    await mkdir(join(currentConfigDir, "targets", "lab-adb-01"), { recursive: true });
    await writeFile(join(currentConfigDir, "targets", "lab-adb-01", "profile.json"), JSON.stringify({
      target_id: "lab-adb-01",
      connections: { adb: { device_id: "ABC123" } },
      safety: { allow_flash: false, allow_reboot: true, allow_shell_exec: true, allow_power_cycle: false },
    }), "utf-8");
    await writeFile(join(currentConfigDir, "targets", "lab-adb-01", "runtime-state.json"), JSON.stringify({
      target_id: "lab-adb-01",
      state: "idle",
      serial: "disconnected",
      adb: "disconnected",
      fastboot: "disconnected",
      updated_at: "2026-01-01T00:00:00Z",
    }), "utf-8");

    const res = await app.inject({ method: "DELETE", url: "/targets/lab-adb-01" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "deleted", target_id: "lab-adb-01" });
  });

  it("DELETE /targets/:targetId refuses busy targets", async () => {
    const app = await createApp();
    await mkdir(join(currentConfigDir, "targets", "lab-adb-01"), { recursive: true });
    await writeFile(join(currentConfigDir, "targets", "lab-adb-01", "profile.json"), JSON.stringify({
      target_id: "lab-adb-01",
      connections: { adb: { device_id: "ABC123" } },
      safety: { allow_flash: false, allow_reboot: true, allow_shell_exec: true, allow_power_cycle: false },
    }), "utf-8");
    await writeFile(join(currentConfigDir, "targets", "lab-adb-01", "runtime-state.json"), JSON.stringify({
      target_id: "lab-adb-01",
      state: "busy",
      current_run_id: "run-live",
      serial: "disconnected",
      adb: "online",
      fastboot: "disconnected",
      updated_at: "2026-01-01T00:00:00Z",
    }), "utf-8");

    const res = await app.inject({ method: "DELETE", url: "/targets/lab-adb-01" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "TARGET_BUSY" } });
  });

  it("DELETE /runs/:runId deletes completed history records", async () => {
    const app = await createApp();
    await mkdir(join(currentConfigDir, "runs", "run-done"), { recursive: true });
    await writeFile(join(currentConfigDir, "runs", "run-done", "run.json"), JSON.stringify({
      run_id: "run-done",
      session_id: "s1",
      state: "completed",
      target_id: "board-01",
      artifact: { path: "/tmp/a.bin", type: "firmware" },
      elapsed_sec: 1,
      last_event_seq: 1,
      evidence_root: join(currentConfigDir, "runs", "run-done"),
      created_at: "2026-01-01T00:00:00Z",
    }), "utf-8");

    const res = await app.inject({ method: "DELETE", url: "/runs/run-done" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "deleted", run_id: "run-done" });
  });

  it("DELETE /runs/:runId refuses active runs", async () => {
    const app = await createApp();
    await mkdir(join(currentConfigDir, "runs", "run-active"), { recursive: true });
    await writeFile(join(currentConfigDir, "runs", "run-active", "run.json"), JSON.stringify({
      run_id: "run-active",
      session_id: "s1",
      state: "running",
      target_id: "board-01",
      artifact: { path: "/tmp/a.bin", type: "firmware" },
      elapsed_sec: 1,
      last_event_seq: 1,
      evidence_root: join(currentConfigDir, "runs", "run-active"),
      created_at: "2026-01-01T00:00:00Z",
    }), "utf-8");

    const res = await app.inject({ method: "DELETE", url: "/runs/run-active" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "RUN_ACTIVE" } });
  });
});
