/**
 * Run routes — HTTP is a thin adapter over CommandHandler/Views.
 * Never touches device connections, EventBus, or Store internals.
 */
import type { FastifyInstance } from "fastify";
import type { CommandHandler } from "@embed-agent/cli";

// CommandHandler's validate expects a flat ValidateRequest from @embed-agent/runtime
interface CreateRunBody {
  artifact: { path: string; type: string; version?: string; build_id?: string };
  target: string;
  expected?: string;
  context?: { task?: string; expected: string; concerns?: string[]; success_criteria?: string[]; failure_criteria?: string[] };
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
  // --- Create run ---
  app.post("/runs", async (request) => {
    const body = request.body as CreateRunBody;

    // Map to ValidateRequest shape: flat expected/concerns, or from context
    const req: Record<string, unknown> = {
      artifact: body.artifact,
      target: body.target,
      expected: body.expected ?? body.context?.expected ?? "",
    };
    if (body.concerns) req.concerns = body.concerns;
    else if (body.context?.concerns) req.concerns = body.context.concerns;
    if (body.success_criteria) req.success_criteria = body.success_criteria;
    else if (body.context?.success_criteria) req.success_criteria = body.context.success_criteria;
    if (body.failure_criteria) req.failure_criteria = body.failure_criteria;
    else if (body.context?.failure_criteria) req.failure_criteria = body.context.failure_criteria;
    if (body.constraints) req.constraints = body.constraints;

    return handler.validate(req as unknown as Parameters<typeof handler.validate>[0]);
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
}
