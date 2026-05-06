/**
 * HTTP Server — thin adapter over CommandHandler/Views.
 * POST /runs → create run. GET /runs/:id/events/stream → SSE.
 * Also runs scheduled tasks via cron.
 * Never touches device connections directly.
 */
import Fastify from "fastify";
import pkg from "@fastify/sse";
const fastifySSE = (pkg as unknown as { default: typeof pkg; fastifySSE: typeof pkg }).default ?? (pkg as unknown as { fastifySSE: typeof pkg }).fastifySSE ?? pkg;
import { bootstrap } from "@embed-agent/cli";
import { TaskStore } from "@embed-agent/stores";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWebUi } from "./register-web-ui.js";

// Lazy-load cron to avoid requiring it for typecheck when not installed
async function loadCron() {
  try { return (await import("node-cron")).default; }
  catch { return null; }
}

async function main() {
  const app = Fastify({ logger: true });
  await app.register(fastifySSE as any, { heartbeatInterval: 30_000 });

  const { handler } = await bootstrap();

  registerRunRoutes(app, handler);
  await registerWebUi(app);

  // ── Scheduled tasks ──────────────────────────────────────
  const taskStore = new TaskStore(process.env["EMBED_AGENT_DATA"] ?? ".embed-agent");
  const cron = await loadCron();
  if (cron) {
    const tasks = await taskStore.list();
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (task.trigger.kind !== "cron") {
        app.log.info(`Task "${task.name}": trigger "${task.trigger.kind}" is not scheduled by cron`);
        continue;
      }
      if (!cron.validate(task.trigger.cron)) {
        app.log.warn(`Task "${task.name}": invalid cron expression "${task.trigger.cron}" — skipping`);
        continue;
      }
      cron.schedule(task.trigger.cron, async () => {
        app.log.info(`Task "${task.name}" triggered`);
        try {
          const result = await (handler as any).validate({
            artifact: task.validation_spec.artifact,
            target: task.validation_spec.target,
            task: task.name,
            source: { kind: "task", task_name: task.name },
            expected: task.validation_spec.expected,
            concerns: task.validation_spec.concerns,
            success_criteria: task.validation_spec.success_criteria,
            failure_criteria: task.validation_spec.failure_criteria,
            constraints: task.validation_spec.constraints,
          });
          if (result?.run_id) {
            await taskStore.updateLastRun(task.name, result.run_id);
            app.log.info(`Task "${task.name}" → run ${result.run_id}`);
          }
        } catch (e) {
          app.log.error(`Task "${task.name}" failed: ${(e as Error).message}`);
        }
      });
      app.log.info(`Task "${task.name}" scheduled: ${task.trigger.cron}`);
    }
  }

  app.addHook("onClose", async () => {
    // cron jobs are cleaned up on process exit
  });

  const port = Number(process.env["PORT"]) || 8787;
  const host = process.env["HOST"] || "127.0.0.1";
  await app.listen({ host, port });
  app.log.info(`Embed Agent HTTP server listening on ${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
