// Shared server startup — used by CLI and MCP to auto-start HTTP Runtime.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8787";
const SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../http-server/dist/main.js");

export async function isServerRunning(url = DEFAULT_URL): Promise<boolean> {
  try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

export async function ensureServer(url = DEFAULT_URL): Promise<void> {
  if (await isServerRunning(url)) return;
  const port = String(new URL(url).port || 8787);
  const proc = spawn("node", [SERVER_ENTRY], { stdio: "ignore", detached: true, env: { ...process.env, PORT: port } });
  proc.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await isServerRunning(url)) return; await new Promise(r => setTimeout(r, 500)); }
  try { proc.kill(); } catch {}
  throw new Error(`Runtime server failed to start at ${url}. Check llm.yml config.`);
}
