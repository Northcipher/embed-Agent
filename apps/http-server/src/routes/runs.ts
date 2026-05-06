/**
 * Run routes — HTTP is a thin adapter over CommandHandler/Views.
 * Never touches device connections, EventBus, or Store internals.
 */
import type { FastifyInstance } from "fastify";
import type { CommandHandler } from "@embed-agent/cli";
import { RunCleanupStore, TargetStore, TaskStore, type TargetProfile, type TaskPolicy, type TaskRecord, type TaskTrigger, type TaskValidationSpec } from "@embed-agent/stores";
import { readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import path from "node:path";

const ALLOWED_CONFIGS = ["llm.yml", "system.yml"];

// CommandHandler's validate expects a flat ValidateRequest from @embed-agent/runtime
interface CreateRunBody {
  artifact: { path: string; type: string; version?: string; build_id?: string };
  target: string;
  deployment_mode?: "observe" | "flash" | "replace" | "install";
  task?: string;
  source?: { kind: "manual" | "task"; task_name?: string };
  reply_language?: "zh" | "en";
  expected?: string;
  context?: { task?: string; expected: string; reply_language?: "zh" | "en"; concerns?: string[]; what_changed?: string; success_criteria?: string[]; failure_criteria?: string[]; observe_interval?: number; observe_metrics?: string[] };
  concerns?: string[];
  success_criteria?: string[];
  failure_criteria?: string[];
  constraints?: { max_duration_sec?: number; allow_flash?: boolean; allow_shell_exec?: boolean; no_flash?: boolean; continuous?: boolean };
}

interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
}

interface TaskBody {
  name?: string;
  validation_spec?: TaskValidationSpec;
  trigger?: TaskTrigger;
  policy?: TaskPolicy;
  enabled?: boolean;
}

interface TargetBody {
  target_id?: string;
  display_name?: string;
  connections?: Record<string, unknown>;
  flash?: TargetProfile["flash"];
  recovery?: TargetProfile["recovery"];
  safety?: TargetProfile["safety"];
  target_hints?: TargetProfile["target_hints"];
  skills?: string[];
}

function numberParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errorBody(code: string, message: string, details?: Record<string, unknown>): { error: { code: string; message: string; details?: Record<string, unknown> } } {
  const error: { code: string; message: string; details?: Record<string, unknown> } = { code, message };
  if (details) error.details = details;
  return { error };
}

function configDir(): string {
  return path.resolve(process.env["EMBED_AGENT_DATA"] ?? ".embed-agent");
}

function runtimeDataRoot(): string {
  try {
    const raw = readFileSync(path.join(configDir(), "system.yml"), "utf-8");
    const data = parse(raw) as Record<string, unknown>;
    const storage = data["storage"];
    if (storage && typeof storage === "object") {
      const dataRoot = (storage as Record<string, unknown>)["data_root"];
      if (typeof dataRoot === "string" && dataRoot) return dataRoot;
    }
  } catch { /* fall back to config root */ }
  return configDir();
}

function maskApiKeys(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { for (const item of obj) maskApiKeys(item); return; }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (key === "api_key") { (obj as Record<string, unknown>)[key] = "***"; continue; }
    maskApiKeys((obj as Record<string, unknown>)[key]);
  }
}

function preserveApiKeys(nextData: unknown, existingData: unknown): void {
  if (!nextData || typeof nextData !== "object" || !existingData || typeof existingData !== "object") return;
  if (Array.isArray(nextData) || Array.isArray(existingData)) return;
  const next = nextData as Record<string, unknown>;
  const existing = existingData as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (key === "api_key") continue;
    preserveApiKeys(next[key], existing[key]);
  }
  if (!("api_key" in next) && typeof existing["api_key"] === "string" && existing["api_key"]) {
    next["api_key"] = existing["api_key"];
  }
}

function redactLlmYaml(raw: string): string {
  return raw.replace(/^(\s*)api_key:.*$/gm, "$1api_key: ***");
}

function activeProvider(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const providerName = root["default_provider"];
  const providers = root["providers"];
  if (typeof providerName !== "string" || !providers || typeof providers !== "object") return null;
  const provider = (providers as Record<string, unknown>)[providerName];
  return provider && typeof provider === "object" ? provider as Record<string, unknown> : null;
}

async function readConfig(name: string): Promise<{ raw: string; data: unknown }> {
  const raw = await readFile(path.join(configDir(), name), "utf-8");
  return { raw, data: parse(raw) };
}

async function configHealth(): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  for (const name of ALLOWED_CONFIGS) {
    try {
      parse(await readFile(path.join(configDir(), name), "utf-8"));
      checks.push({ name, status: "ok", message: "loaded" });
    } catch (e) {
      checks.push({ name, status: "error", message: errMsg(e) });
    }
  }

  try {
    const { data } = await readConfig("llm.yml");
    const provider = activeProvider(data);
    const providerType = typeof provider?.["type"] === "string" ? provider["type"] as string : "unknown";
    const apiKeyEnv = typeof provider?.["api_key_env"] === "string" ? provider["api_key_env"] as string : undefined;
    const hasInlineKey = typeof provider?.["api_key"] === "string" && (provider["api_key"] as string).length > 0;
    const hasEnvKey = apiKeyEnv ? Boolean(process.env[apiKeyEnv]) : false;
    const status = providerType === "mock" || hasInlineKey || hasEnvKey ? "ok" : "warn";
    checks.push({
      name: "llm_credentials",
      status,
      message: status === "ok" ? "credential available" : "missing API key",
      details: { provider_type: providerType, api_key_env: apiKeyEnv, has_inline_key: hasInlineKey, has_env_key: hasEnvKey },
    });
  } catch (e) {
    checks.push({ name: "llm_credentials", status: "error", message: errMsg(e) });
  }
  return checks;
}

function taskStore(): TaskStore {
  return new TaskStore(runtimeDataRoot());
}

function targetStore(): TargetStore {
  return new TargetStore(runtimeDataRoot());
}

function runCleanupStore(): RunCleanupStore {
  return new RunCleanupStore(runtimeDataRoot());
}

function validateTargetProfile(profile: unknown): profile is TargetProfile {
  if (!profile || typeof profile !== "object") return false;
  const raw = profile as Record<string, unknown>;
  const connections = raw["connections"];
  const safety = raw["safety"];
  if (typeof raw["target_id"] !== "string" || !raw["target_id"]) return false;
  if (!connections || typeof connections !== "object") return false;
  if (!safety || typeof safety !== "object") return false;
  const safetyRaw = safety as Record<string, unknown>;
  return typeof safetyRaw["allow_flash"] === "boolean"
    && typeof safetyRaw["allow_reboot"] === "boolean"
    && typeof safetyRaw["allow_shell_exec"] === "boolean"
    && typeof safetyRaw["allow_power_cycle"] === "boolean";
}

function validateTaskSpec(spec: unknown): spec is TaskValidationSpec {
  if (!spec || typeof spec !== "object") return false;
  const raw = spec as Record<string, unknown>;
  const artifact = raw["artifact"];
  const deploymentMode = raw["deployment_mode"];
  const artifactRequired = deploymentMode !== "observe";
  return typeof raw["target"] === "string" && raw["target"].length > 0
    && typeof raw["expected"] === "string" && raw["expected"].length > 0
    && Boolean(artifact) && typeof artifact === "object"
    && typeof (artifact as Record<string, unknown>)["path"] === "string"
    && (!artifactRequired || ((artifact as Record<string, unknown>)["path"] as string).length > 0);
}

function validateTaskTrigger(trigger: unknown): trigger is TaskTrigger {
  if (!trigger || typeof trigger !== "object") return false;
  const raw = trigger as Record<string, unknown>;
  if (raw["kind"] === "cron") return typeof raw["cron"] === "string" && raw["cron"].length > 0;
  if (raw["kind"] === "file_event") return typeof raw["pattern"] === "string" && raw["pattern"].length > 0;
  return raw["kind"] === "continuous";
}

function normalizeTaskPolicy(policy: unknown): TaskPolicy {
  if (!policy || typeof policy !== "object") return { overlap: "skip_if_target_busy", failure: "notify_and_keep_enabled" };
  const raw = policy as Record<string, unknown>;
  const overlap = raw["overlap"] === "queue_next_run" || raw["overlap"] === "cancel_older_run" ? raw["overlap"] : "skip_if_target_busy";
  const failure = raw["failure"] === "pause_after_3_failures" || raw["failure"] === "collect_extra_evidence" ? raw["failure"] : "notify_and_keep_enabled";
  return { overlap, failure };
}

function taskRunBody(task: TaskRecord): Parameters<typeof CommandHandler.prototype.validate>[0] {
  const req: Record<string, unknown> = {
    artifact: task.validation_spec.artifact,
    target: task.validation_spec.target,
    expected: task.validation_spec.expected,
    task: task.validation_spec.task ?? task.name,
    source: { kind: "task", task_name: task.name },
  };
  if (task.validation_spec.deployment_mode) req.deployment_mode = task.validation_spec.deployment_mode;
  if (task.validation_spec.concerns) req.concerns = task.validation_spec.concerns;
  if (task.validation_spec.reply_language) req.reply_language = task.validation_spec.reply_language;
  if (task.validation_spec.success_criteria) req.success_criteria = task.validation_spec.success_criteria;
  if (task.validation_spec.failure_criteria) req.failure_criteria = task.validation_spec.failure_criteria;
  if (task.validation_spec.constraints) req.constraints = task.validation_spec.constraints;
  return req as unknown as Parameters<typeof CommandHandler.prototype.validate>[0];
}

export function registerRunRoutes(app: FastifyInstance, handler: CommandHandler) {
  // --- Health ---
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/health/full", async () => {
    const checks: HealthCheck[] = [{ name: "http", status: "ok", message: "serving" }];

    const [configChecks, targetsResult] = await Promise.allSettled([
      configHealth(),
      handler.targetList(),
    ]);
    if (configChecks.status === "fulfilled") checks.push(...configChecks.value);
    else checks.push({ name: "config", status: "error", message: errMsg(configChecks.reason) });

    if (targetsResult.status === "fulfilled") {
      const targets = targetsResult.value;
      checks.push({
        name: "targets",
        status: targets.length > 0 ? "ok" : "warn",
        message: targets.length > 0 ? `${targets.length} target(s)` : "no targets configured",
        details: { count: targets.length, offline: targets.filter(t => t.state === "offline").length },
      });
    } else {
      checks.push({ name: "targets", status: "error", message: errMsg(targetsResult.reason) });
    }

    const status = checks.some(c => c.status === "error") ? "error" : checks.some(c => c.status === "warn") ? "warn" : "ok";
    return { status, checks, generated_at: new Date().toISOString() };
  });

  // --- Targets ---
  app.get("/targets", async () => {
    return handler.targetList();
  });

  app.get("/targets/:targetId/capabilities", async (request) => {
    const { targetId } = request.params as { targetId: string };
    return handler.getTargetCapabilities(targetId);
  });

  app.get("/targets/:targetId/history", async (request) => {
    const { targetId } = request.params as { targetId: string };
    const query = request.query as { limit?: string };
    return handler.history(targetId, numberParam(query.limit, 10));
  });

  app.post("/targets", async (request, reply) => {
    const body = request.body as TargetBody | null;
    if (!validateTargetProfile(body)) {
      return reply.status(422).send(errorBody("VALIDATION_ERROR", "target_id, connections, and full safety policy are required"));
    }
    await targetStore().add(body);
    return { status: "created", target: body };
  });

  app.delete("/targets/:targetId", async (request, reply) => {
    const { targetId } = request.params as { targetId: string };
    const store = targetStore();
    const profile = await store.get(targetId);
    if (!profile) return reply.status(404).send(errorBody("NOT_FOUND", `Target not found: ${targetId}`));

    const state = await store.getState(targetId);
    if (state?.current_run_id || (state && !["idle", "offline", "dirty"].includes(state.state))) {
      return reply.status(409).send(errorBody("TARGET_BUSY", "Active test devices cannot be deleted", { target_id: targetId, state: state?.state ?? "unknown", run_id: state?.current_run_id ?? "" }));
    }

    await store.remove(targetId);
    return { status: "deleted", target_id: targetId };
  });

  // --- Create run ---
  app.post("/runs", async (request) => {
    const body = request.body as CreateRunBody | null;
    const artifactRequired = body?.deployment_mode !== "observe";
    if (!body || !body.target || (artifactRequired && !body.artifact?.path)) {
      return { status: "invalid_request", reasons: [artifactRequired ? "artifact.path and target are required" : "target is required"] };
    }

    // Map to ValidateRequest shape with full context fields
    const req: Record<string, unknown> = {
      artifact: body.artifact,
      target: body.target,
      expected: body.expected ?? body.context?.expected ?? "",
    };
    if (body.deployment_mode) req.deployment_mode = body.deployment_mode;
    if (body.task) req.task = body.task;
    if (body.source) req.source = body.source;
    if (body.reply_language) req.reply_language = body.reply_language;
    else if (body.context?.reply_language) req.reply_language = body.context.reply_language;
    if (body.context?.task) req.task = body.context.task;
    if (body.context?.what_changed) req.what_changed = body.context.what_changed;
    if (body.concerns) req.concerns = body.concerns;
    else if (body.context?.concerns) req.concerns = body.context.concerns;
    if (body.success_criteria) req.success_criteria = body.success_criteria;
    else if (body.context?.success_criteria) req.success_criteria = body.context.success_criteria;
    if (body.failure_criteria) req.failure_criteria = body.failure_criteria;
    else if (body.context?.failure_criteria) req.failure_criteria = body.context.failure_criteria;
    if (body.constraints) {
      req.constraints = { ...body.constraints };
      // Preserve observe_interval/observe_metrics from context that aren't in the flat constraints type
      if (body.context?.observe_interval != null) (req.constraints as any).observe_interval = body.context.observe_interval;
      if (body.context?.observe_metrics != null) (req.constraints as any).observe_metrics = body.context.observe_metrics;
    }

    return handler.validate(req as unknown as Parameters<typeof handler.validate>[0]);
  });

  app.post("/runs/preflight", async (request) => {
    const body = request.body as Partial<CreateRunBody> | null;
    const checks: HealthCheck[] = [];
    const artifactRequired = body?.deployment_mode !== "observe";
    if (!body?.target) {
      checks.push({ name: "target", status: "error", message: "target is required" });
    } else {
      const targets = await handler.targetList();
      const target = targets.find(t => t.target_id === body.target);
      if (!target) {
        checks.push({ name: "target", status: "error", message: `target not found: ${body.target}` });
      } else if (target.state === "offline") {
        checks.push({ name: "target", status: "error", message: "target is offline", details: target as unknown as Record<string, unknown> });
      } else if (target.state === "busy") {
        checks.push({ name: "target", status: "warn", message: "target is busy", details: target as unknown as Record<string, unknown> });
      } else {
        checks.push({ name: "target", status: "ok", message: target.state, details: target as unknown as Record<string, unknown> });
      }

      const caps = await handler.getTargetCapabilities(body.target);
      if ("error_code" in caps) {
        checks.push({ name: "capabilities", status: "error", message: caps.message });
      } else {
        checks.push({
          name: "capabilities",
          status: "ok",
          message: caps.capabilities.length > 0 ? caps.capabilities.join(", ") : "no active capabilities",
          details: { capabilities: caps.capabilities },
        });
      }
    }

    if (!artifactRequired) {
      checks.push({ name: "artifact", status: "ok", message: "artifact not required for observe mode" });
    } else if (!body?.artifact?.path) {
      checks.push({ name: "artifact", status: "error", message: "artifact.path is required" });
    } else {
      try {
        await access(body.artifact.path);
        checks.push({ name: "artifact", status: "ok", message: "file exists", details: { path: body.artifact.path } });
      } catch {
        checks.push({ name: "artifact", status: "error", message: "file not readable", details: { path: body.artifact.path } });
      }
    }

    const constraints = body?.constraints ?? {};
    checks.push({
      name: "safety",
      status: constraints.allow_flash === true && constraints.no_flash === true ? "error" : "ok",
      message: constraints.allow_flash === true && constraints.no_flash === true ? "allow_flash conflicts with no_flash" : "constraints accepted",
      details: {
        allow_flash: constraints.allow_flash ?? false,
        no_flash: constraints.no_flash ?? false,
        allow_shell_exec: constraints.allow_shell_exec ?? false,
      },
    });

    const status = checks.some(c => c.status === "error") ? "blocked" : checks.some(c => c.status === "warn") ? "warn" : "ready";
    return { status, checks };
  });

  app.delete("/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const result = await runCleanupStore().deleteRun(runId);
    if (result.status === "not_found") return reply.status(404).send(errorBody("NOT_FOUND", `Run not found: ${runId}`));
    if (result.status === "run_active") return reply.status(409).send(errorBody("RUN_ACTIVE", "Running validations cannot be deleted", { run_id: runId, state: result.state }));
    return result;
  });

  // --- Automation tasks ---
  app.get("/tasks", async () => {
    const tasks = await taskStore().list();
    return { tasks };
  });

  app.get("/tasks/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const task = await taskStore().get(name);
    if (!task) return reply.status(404).send(errorBody("NOT_FOUND", `Task not found: ${name}`));
    return { task };
  });

  app.post("/tasks", async (request, reply) => {
    const body = request.body as TaskBody | null;
    if (!body?.name || !body.validation_spec || !body.trigger) {
      return reply.status(400).send(errorBody("INVALID_REQUEST", "name, validation_spec, and trigger are required"));
    }
    if (!validateTaskSpec(body.validation_spec)) {
      return reply.status(422).send(errorBody("VALIDATION_ERROR", "validation_spec.target, validation_spec.expected, and validation_spec.artifact are required"));
    }
    if (!validateTaskTrigger(body.trigger)) {
      return reply.status(422).send(errorBody("VALIDATION_ERROR", "trigger is invalid"));
    }

    const now = new Date().toISOString();
    const task: TaskRecord = {
      name: body.name,
      validation_spec: body.validation_spec,
      trigger: body.trigger,
      policy: normalizeTaskPolicy(body.policy),
      enabled: body.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await taskStore().add(task);
    return { status: "created", task };
  });

  app.patch("/tasks/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as Omit<TaskBody, "name"> | null;
    if (!body) return reply.status(400).send(errorBody("INVALID_REQUEST", "Missing body"));

    const patch: Partial<Omit<TaskRecord, "name" | "createdAt">> = {};
    if (body.validation_spec !== undefined) {
      if (!validateTaskSpec(body.validation_spec)) return reply.status(422).send(errorBody("VALIDATION_ERROR", "validation_spec is invalid"));
      patch.validation_spec = body.validation_spec;
    }
    if (body.trigger !== undefined) {
      if (!validateTaskTrigger(body.trigger)) return reply.status(422).send(errorBody("VALIDATION_ERROR", "trigger is invalid"));
      patch.trigger = body.trigger;
    }
    if (body.policy !== undefined) patch.policy = normalizeTaskPolicy(body.policy);
    if (body.enabled !== undefined) patch.enabled = body.enabled;

    const task = await taskStore().update(name, patch);
    if (!task) return reply.status(404).send(errorBody("NOT_FOUND", `Task not found: ${name}`));
    return { status: "updated", task };
  });

  app.delete("/tasks/:name", async (request) => {
    const { name } = request.params as { name: string };
    await taskStore().remove(name);
    return { status: "deleted", name };
  });

  app.post("/tasks/:name/run", async (request, reply) => {
    const { name } = request.params as { name: string };
    const store = taskStore();
    const task = await store.get(name);
    if (!task) return reply.status(404).send(errorBody("NOT_FOUND", `Task not found: ${name}`));
    const result = await handler.validate(taskRunBody(task));
    if (result.run_id) await store.updateLastRun(name, result.run_id);
    return result;
  });

  // --- Run intervention ---
  app.post("/runs/:runId/interventions", async (request) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as {
      action: "pause" | "resume" | "cancel" | "add_instruction" | "ignore_rule" | "override";
      reason?: string;
      instruction?: string;
      rule_id?: string;
      decision?: "continue" | "stop" | "cancel";
    };

    switch (body.action) {
      case "pause":
        return handler.pause(runId, body.reason ?? "manual");
      case "resume":
        return handler.resume(runId);
      case "cancel":
        return handler.cancel(runId, body.reason ?? "manual");
      case "add_instruction":
        return handler.addInstruction(runId, body.instruction ?? body.reason ?? "");
      case "ignore_rule":
        return handler.ignoreRule(runId, body.rule_id ?? "");
      case "override":
        return handler.override(runId, body.decision ?? "continue", body.reason);
    }
  });

  // --- Run status ---
  app.get("/runs/:runId/status", async (request) => {
    const { runId } = request.params as { runId: string };
    return handler.status(runId);
  });

  // --- Events (paginated) ---
  app.get("/runs/:runId/events", async (request) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { after_seq?: string; limit?: string; types?: string };
    return handler.events(
      runId,
      numberParam(query.after_seq, 0),
      numberParam(query.limit, 100),
      query.types ? query.types.split(",").filter(Boolean) : undefined,
    );
  });

  // --- Events SSE stream ---
  app.get("/runs/:runId/events/stream", { sse: true }, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { after_seq?: string; types?: string };
    const types = query.types ? query.types.split(",").filter(Boolean) : undefined;
    if (!reply.sse) {
      return reply.status(406).send(errorBody("SSE_REQUIRED", "Set Accept: text/event-stream to stream run events"));
    }

    let afterSeq = numberParam(reply.sse.lastEventId ?? query.after_seq, 0);

    // Catch up on missed events
    await reply.sse.replay(async (lastId) => {
      afterSeq = numberParam(lastId, 0);
      const page = await handler.events(runId, afterSeq, 200, types);
      for (const event of page.events) {
        await reply.sse.send({
          id: String(event.seq),
          event: event.type,
          data: event,
        });
        afterSeq = event.seq;
      }
    });

    reply.sse.keepAlive();

    // Send initial connected event so client has data immediately
    await reply.sse.send({ event: "connected", data: { run_id: runId, after_seq: afterSeq } });

    // Poll for new events
    const timer = setInterval(async () => {
      if (!reply.sse.isConnected) {
        clearInterval(timer);
        return;
      }
      try {
        const page = await handler.events(runId, afterSeq, 50, types);
        for (const event of page.events) {
          await reply.sse.send({
            id: String(event.seq),
            event: event.type,
            data: event,
          });
          afterSeq = event.seq;
        }
      } catch {
        // Run might have ended or been cleaned up
        clearInterval(timer);
        await reply.sse.close();
      }
    }, 1000);

    reply.sse.onClose(() => clearInterval(timer));
  });

  // --- Run result ---
  app.get("/runs/:runId/result", async (request) => {
    const { runId } = request.params as { runId: string };
    return handler.result(runId);
  });

  // --- Evidence ---
  app.get("/runs/:runId/evidence", async (request) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { ref?: string };
    return handler.evidence(runId, query.ref);
  });

  // --- Config ---
  app.get("/config/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!ALLOWED_CONFIGS.includes(name)) return reply.status(403).send({ error: `Config "${name}" not allowed. Use: ${ALLOWED_CONFIGS.join(", ")}` });
    try {
      const raw = await readFile(path.join(configDir(), name), "utf-8");
      const data = parse(raw);
      // Mask secrets before sending over HTTP
      maskApiKeys(data);
      const yamlOut = name === "llm.yml" ? redactLlmYaml(raw) : raw;
      return { name, yaml: yamlOut, data };
    } catch { return reply.status(404).send({ error: `Config "${name}" not found` }); }
  });

  app.put("/config/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!ALLOWED_CONFIGS.includes(name)) return reply.status(403).send({ error: `Config "${name}" not allowed` });
    const body = request.body as { yaml?: string; data?: Record<string, unknown> } | null;
    if (!body) return reply.status(400).send({ error: "Missing body" });
    try {
      let content = body.yaml ?? (body.data ? stringify(body.data) : null);
      if (!content) return reply.status(400).send({ error: "Missing yaml or data field" });
      const parsed = parse(content);
      if (name === "llm.yml" && body.data) {
        try {
          const existing = parse(await readFile(path.join(configDir(), name), "utf-8"));
          preserveApiKeys(parsed, existing);
          content = stringify(parsed);
        } catch { /* no existing key to preserve */ }
      }
      await writeFile(path.join(configDir(), name), content, "utf-8");
      return { status: "ok", name };
    } catch (e: any) { return reply.status(400).send({ error: `Invalid: ${e.message}` }); }
  });

  app.post("/config/llm.yml/test", async () => {
    try {
      const { data } = await readConfig("llm.yml");
      const provider = activeProvider(data);
      if (!provider) return { status: "error", message: "No active provider in llm.yml" };
      const type = provider["type"] as string | undefined;
      const apiKeyEnv = provider["api_key_env"] as string | undefined;
      const hasInlineKey = typeof provider["api_key"] === "string" && (provider["api_key"] as string).length > 0;
      const hasEnvKey = apiKeyEnv ? Boolean(process.env[apiKeyEnv]) : false;
      if (type === "mock") return { status: "ok", message: "Mock provider does not require an API key" };
      if (!hasInlineKey && !hasEnvKey) return { status: "error", message: `No API key configured${apiKeyEnv ? ` and ${apiKeyEnv} is not set` : ""}` };
      return { status: "ok", message: hasInlineKey ? "Inline API key configured" : `Using ${apiKeyEnv}` };
    } catch (e) {
      return { status: "error", message: errMsg(e) };
    }
  });
}
