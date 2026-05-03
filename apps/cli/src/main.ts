// CLI entry point — thin HTTP client. Auto-starts server if needed.
import { runCli } from "./cli.js";
import { HttpCommandHandler } from "./http-client.js";
import { isServerRunning, ensureServer } from "./server-start.js";

const DEFAULT_URL = process.env["EMBED_AGENT_SERVER_URL"] ?? "http://127.0.0.1:8787";

function detectCommand(argv: string[]): string {
  return argv.find(arg => !arg.startsWith("-")) ?? "help";
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  let serverUrl = DEFAULT_URL;
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]!;
    if (arg === "--server") { const n = rawArgv[i + 1]; if (n) { serverUrl = n; i++; } }
    else if (arg.startsWith("--server=")) { serverUrl = arg.slice("--server=".length); }
    else { argv.push(arg); }
  }

  const command = detectCommand(argv);

  if (command === "help") {
    await runCli(null as never, argv);
    return;
  }

  if (!(await isServerRunning(serverUrl))) {
    process.stderr.write(`Runtime server not running. Starting...\n`);
    await ensureServer(serverUrl);
  }
  await runCli(new HttpCommandHandler(serverUrl) as never, argv);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
