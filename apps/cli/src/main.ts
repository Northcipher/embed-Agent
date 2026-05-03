// CLI entry point — thin HTTP client. Auto-starts the runtime server if needed.
import { runCli } from "./cli.js";
import { HttpCommandHandler } from "./http-client.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

function detectCommand(argv: string[]): string {
  return argv.find(arg => !arg.startsWith("-")) ?? "help";
}

async function isServerRunning(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function startServer(serverUrl: string): Promise<void> {
  // Find server entry relative to this CLI module
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const serverEntry = path.resolve(cliDir, "../../http-server/dist/main.js");

  const port = String(new URL(serverUrl).port || 8787);
  const proc = spawn("node", [serverEntry], {
    stdio: "ignore", detached: true,
    env: { ...process.env, PORT: port },
  });
  proc.unref();

  // Wait for server to become ready
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isServerRunning(serverUrl)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  try { proc.kill(); } catch {}
  throw new Error(`Runtime server failed to start at ${serverUrl}. Check config: llm.yml must have valid API key.`);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // Parse --server flag
  let serverUrl = process.env["EMBED_AGENT_SERVER_URL"] ?? DEFAULT_SERVER_URL;
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]!;
    if (arg === "--server") { const n = rawArgv[i + 1]; if (n) { serverUrl = n; i++; } }
    else if (arg.startsWith("--server=")) { serverUrl = arg.slice("--server=".length); }
    else { argv.push(arg); }
  }

  const command = detectCommand(argv);

  // help runs without Runtime
  if (command === "help") {
    await runCli(null as never, argv);
    return;
  }

  // Auto-start server if needed, then forward command
  if (!(await isServerRunning(serverUrl))) {
    process.stderr.write(`Runtime server not running. Starting...\n`);
    await startServer(serverUrl);
  }
  await runCli(new HttpCommandHandler(serverUrl) as never, argv);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
