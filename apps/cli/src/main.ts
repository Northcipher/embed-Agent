// CLI entry point — creates stores and Views for query commands.
// Full RunManager/Agent wiring is in bootstrap.ts for production use.
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, Logger } from "@embed-agent/stores";
import { Views } from "@embed-agent/views";
import { CommandHandler } from "./command-handler.js";
import { runCli } from "./cli.js";

async function main(): Promise<void> {
  const dataRoot = process.env["EMBED_AGENT_DATA"] ?? ".embed-agent";
  const log = new Logger({ module: "cli" });

  // Create stores for read-only query support
  const eventStore = new EventStore(dataRoot);
  const runStore = new RunStore(dataRoot, log);
  const targetStore = new TargetStore(dataRoot);
  const memoryStore = new MemoryStore(dataRoot);

  // Create Views (read-only — works without RunManager)
  const views = new Views(runStore, eventStore, new EvidenceStore(dataRoot), targetStore, memoryStore);

  // CommandHandler with query support only.
  // Validate/intervene require RunManager (null here — they will return errors gracefully).
  const handler = new CommandHandler(null as never, views);

  await runCli(handler);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
