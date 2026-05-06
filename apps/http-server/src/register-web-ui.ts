import type { FastifyInstance, FastifyReply } from "fastify";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function defaultWebUiDist(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../webui/dist");
}

function resolveWebUiDist(): string {
  const fromEnv = process.env["EMBED_AGENT_WEB_DIST"];
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return defaultWebUiDist();
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function canRead(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function sendFile(reply: FastifyReply, filePath: string) {
  const body = await readFile(filePath);
  return reply.type(contentTypeFor(filePath)).send(body);
}

export async function registerWebUi(app: FastifyInstance): Promise<void> {
  const distDir = resolveWebUiDist();
  const indexFile = path.join(distDir, "index.html");

  if (!(await canRead(indexFile))) {
    app.log.warn(`Web UI build not found at ${distDir}. Run "pnpm build" to enable browser UI.`);
    return;
  }

  app.get("/", async (_request, reply) => sendFile(reply, indexFile));

  app.get("/index.html", async (_request, reply) => sendFile(reply, indexFile));

  app.get("/assets/*", async (request, reply) => {
    const pathname = new URL(request.raw.url ?? "/assets/", "http://127.0.0.1").pathname;
    const relativePath = pathname.replace(/^\/+/, "");
    const filePath = path.join(distDir, relativePath);
    if (!filePath.startsWith(path.join(distDir, "assets"))) {
      return reply.code(404).send({ error: "asset_not_found" });
    }
    if (!(await canRead(filePath))) {
      return reply.code(404).send({ error: "asset_not_found" });
    }
    return sendFile(reply, filePath);
  });
}
