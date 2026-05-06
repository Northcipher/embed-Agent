// Shared server startup — used by CLI and MCP to auto-start HTTP Runtime.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8787";
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLI_DIR, "../../..");
const SERVER_ENTRY = path.resolve(CLI_DIR, "../../http-server/dist/main.js");
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, ".embed-agent");
const DEFAULT_WEB_DIST = path.join(REPO_ROOT, "apps/webui/dist");

export async function isServerRunning(url = DEFAULT_URL): Promise<boolean> {
  try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

export async function ensureServer(url = DEFAULT_URL): Promise<void> {
  if (await isServerRunning(url)) return;
  const port = String(new URL(url).port || 8787);
  const proc = spawn("node", [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      PORT: port,
      HOST: new URL(url).hostname || "127.0.0.1",
      EMBED_AGENT_DATA: process.env["EMBED_AGENT_DATA"] ?? DEFAULT_DATA_DIR,
      EMBED_AGENT_WEB_DIST: process.env["EMBED_AGENT_WEB_DIST"] ?? DEFAULT_WEB_DIST,
      EMBED_AGENT_SERVER_URL: process.env["EMBED_AGENT_SERVER_URL"] ?? url,
    },
  });
  proc.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await isServerRunning(url)) return; await new Promise(r => setTimeout(r, 500)); }
  try { proc.kill(); } catch {}
  throw new Error(`Runtime server failed to start at ${url}. Check llm.yml config.`);
}
