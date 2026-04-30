// CLI entry point — creates stores and Views for query commands.
// Full RunManager/Agent wiring is in bootstrap.ts for production use.
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, Logger } from "@embed-agent/stores";
import { Views } from "@embed-agent/views";
import { CommandHandler } from "./command-handler.js";
import { runCli } from "./cli.js";

/**
 * Safe wrapper: when RunManager is null, mutation commands (validate/pause/resume/cancel)
 * return graceful errors instead of crashing. Query commands work via Views.
 */
function safeHandler(views: Views): CommandHandler {
  const handler = new CommandHandler(null as never, views);

  // Override mutation methods to return graceful errors
  const origValidate = handler.validate.bind(handler);
  handler.validate = async (req) => {
    try { return await origValidate(req); }
    catch { return { status: "error", reasons: ["RunManager not available — start with bootstrap for full functionality"] }; }
  };
  handler.pause = async () => ({ accepted: false, run_id: "", status: "error", error_code: "internal_error", message: "RunManager not available" });
  handler.resume = async () => ({ accepted: false, run_id: "", status: "error", error_code: "internal_error", message: "RunManager not available" });
  handler.cancel = async () => ({ accepted: false, run_id: "", status: "error", error_code: "internal_error", message: "RunManager not available" });

  return handler;
}

async function main(): Promise<void> {
  const dataRoot = process.env["EMBED_AGENT_DATA"] ?? ".embed-agent";
  const log = new Logger({ module: "cli" });

  const runStore = new RunStore(dataRoot, log);
  const targetStore = new TargetStore(dataRoot);
  const memoryStore = new MemoryStore(dataRoot);
  const eventStore = new EventStore(dataRoot);

  const views = new Views(runStore, eventStore, new EvidenceStore(dataRoot), targetStore, memoryStore);
  const handler = safeHandler(views);

  // Wire management commands to real store data
  const origMemList = handler.memoryList;
  handler.memoryList = async (targetId?: string, category?: string) => {
    try {
      const facts = await memoryStore.queryFacts("target", targetId ?? "", category);
      const entries = facts.filter((f: { statement: string }) => f.statement !== "__DELETED__").map((f: { fact_id: string; category: string; statement: string; verified: boolean }) => ({ fact_id: f.fact_id, category: f.category, statement: f.statement, verified: f.verified }));
      return { entries, status: "ok" };
    } catch { return origMemList(targetId, category); }
  };

  await runCli(handler);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
