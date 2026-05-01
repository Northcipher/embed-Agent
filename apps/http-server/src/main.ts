/**
 * HTTP Server — thin adapter over CommandHandler/Views.
 * POST /runs → create run. GET /runs/:id/events/stream → SSE.
 * Never touches device connections directly.
 */
import Fastify from "fastify";
// @fastify/sse v0.4.0 exports a CJS module with `default` and `fastifySSE` named export
import pkg from "@fastify/sse";
const fastifySSE = (pkg as unknown as { default: typeof pkg; fastifySSE: typeof pkg }).default ?? (pkg as unknown as { fastifySSE: typeof pkg }).fastifySSE ?? pkg;
import { bootstrap } from "@embed-agent/cli";
import { registerRunRoutes } from "./routes/runs.js";

async function main() {
  const app = Fastify({ logger: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(fastifySSE as any, { heartbeatInterval: 30_000 });

  const { handler, shutdown } = await bootstrap();

  registerRunRoutes(app, handler);

  app.addHook("onClose", async () => {
    await shutdown();
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
