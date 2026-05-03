// CLI entry point — thin HTTP client. Runtime state lives in the HTTP server.
import { runCli } from "./cli.js";
import { HttpCommandHandler } from "./http-client.js";

function detectCommand(argv: string[]): string {
  return argv.find(arg => !arg.startsWith("-")) ?? "help";
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // Parse --server flag
  let serverUrl = process.env["EMBED_AGENT_SERVER_URL"] ?? "http://127.0.0.1:8787";
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]!;
    if (arg === "--server") {
      const next = rawArgv[i + 1];
      if (next) { serverUrl = next; i++; }
    } else if (arg.startsWith("--server=")) {
      serverUrl = arg.slice("--server=".length);
    } else {
      argv.push(arg);
    }
  }

  const command = detectCommand(argv);

  // help runs without Runtime
  if (command === "help") {
    await runCli(null as never, argv);
    return;
  }

  // Everything else → HTTP Runtime
  await runCli(new HttpCommandHandler(serverUrl) as never, argv);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
