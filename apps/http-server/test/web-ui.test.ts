import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWebUi } from "../src/register-web-ui.js";

describe("registerWebUi", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const previousDist = process.env["EMBED_AGENT_WEB_DIST"];

  afterEach(async () => {
    await Promise.all(apps.map(app => app.close()));
    apps.length = 0;
    if (previousDist === undefined) delete process.env["EMBED_AGENT_WEB_DIST"];
    else process.env["EMBED_AGENT_WEB_DIST"] = previousDist;
  });

  async function createApp(): Promise<ReturnType<typeof Fastify>> {
    const root = await mkdtemp(join(tmpdir(), "embed-agent-webui-"));
    const dist = join(root, "dist");
    const assets = join(dist, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><html><body>Embed Agent</body></html>");
    await writeFile(join(assets, "app.js"), "console.log('ok');");
    process.env["EMBED_AGENT_WEB_DIST"] = dist;

    const app = Fastify({ logger: false });
    apps.push(app);
    await registerWebUi(app);
    await app.ready();
    return app;
  }

  it("serves index.html at root", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Embed Agent");
  });

  it("serves built assets", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toContain("console.log");
  });

  it("returns 404 for missing assets", async () => {
    const app = await createApp();
    const res = await app.inject({ method: "GET", url: "/assets/missing.js" });

    expect(res.statusCode).toBe(404);
  });
});
