/**
 * Run routes — HTTP is a thin adapter over CommandHandler/Views.
 * Never touches device connections, EventBus, or Store internals.
 */
import type { FastifyInstance } from "fastify";
import type { CommandHandler } from "@embed-agent/cli";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import path from "node:path";

const CONFIG_DIR = path.resolve(process.env["EMBED_AGENT_DATA"] ?? ".embed-agent");
const ALLOWED_CONFIGS = ["llm.yml", "system.yml"];

// CommandHandler's validate expects a flat ValidateRequest from @embed-agent/runtime
interface CreateRunBody {
  artifact: { path: string; type: string; version?: string; build_id?: string };
  target: string;
  expected?: string;
  context?: { task?: string; expected: string; concerns?: string[]; what_changed?: string; success_criteria?: string[]; failure_criteria?: string[]; observe_interval?: number; observe_metrics?: string[] };
  concerns?: string[];
  success_criteria?: string[];
  failure_criteria?: string[];
  constraints?: { max_duration_sec?: number; allow_flash?: boolean; allow_shell_exec?: boolean; no_flash?: boolean; continuous?: boolean };
}

function numberParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function registerRunRoutes(app: FastifyInstance, handler: CommandHandler) {
  // --- Health ---
  app.get("/health", async () => ({ status: "ok" }));

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

  // --- Create run ---
  app.post("/runs", async (request) => {
    const body = request.body as CreateRunBody | null;
    if (!body || !body.artifact?.path || !body.target) {
      return { status: "invalid_request", reasons: ["artifact.path and target are required"] };
    }

    // Map to ValidateRequest shape with full context fields
    const req: Record<string, unknown> = {
      artifact: body.artifact,
      target: body.target,
      expected: body.expected ?? body.context?.expected ?? "",
    };
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
      const raw = await readFile(path.join(CONFIG_DIR, name), "utf-8");
      const data = parse(raw);
      return { name, yaml: raw, data };
    } catch { return reply.status(404).send({ error: `Config "${name}" not found` }); }
  });

  app.put("/config/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!ALLOWED_CONFIGS.includes(name)) return reply.status(403).send({ error: `Config "${name}" not allowed` });
    const body = request.body as { yaml?: string; data?: Record<string, unknown> } | null;
    if (!body) return reply.status(400).send({ error: "Missing body" });
    try {
      const content = body.yaml ?? (body.data ? stringify(body.data) : null);
      if (!content) return reply.status(400).send({ error: "Missing yaml or data field" });
      parse(content); // validate
      await writeFile(path.join(CONFIG_DIR, name), content, "utf-8");
      return { status: "ok", name };
    } catch (e: any) { return reply.status(400).send({ error: `Invalid: ${e.message}` }); }
  });
}
