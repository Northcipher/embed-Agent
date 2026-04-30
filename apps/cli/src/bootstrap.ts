import { ConfigLoader, Logger, PromptLoader, EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore } from "@embed-agent/stores";
import { EventBus, ContextAssembler } from "@embed-agent/runtime";
import { CommandHandler } from "./command-handler.js";
import { runCli } from "./cli.js";

interface BootstrapResult {
  handler: CommandHandler;
  logger: Logger;
  shutdown: () => Promise<void>;
}

/**
 * Production bootstrap: loads config, creates all services, wires them together.
 * If any required config fails, prints errors and calls process.exit(1).
 */
export async function bootstrap(configRoot = ".embed-agent"): Promise<BootstrapResult> {
  const logger = new Logger({ module: "bootstrap", pretty: true });

  // 1. Load configs
  const loader = new ConfigLoader(configRoot, logger);
  const { configs, errors } = await loader.loadAll({
    "targets.yml": { schema: { safeParse: (d: unknown) => ({ success: true, data: d }) }, required: false },
    "system.yml": { schema: { safeParse: (d: unknown) => ({ success: true, data: d }) }, required: false },
  });

  if (errors.length > 0) {
    logger.error("Config validation failed", { errors });
    for (const e of errors) {
      process.stderr.write(`  ${e.file}: ${e.message}\n`);
    }
    process.exit(1);
  }

  // 2. Create stores
  const dataRoot = (configs["system"] as Record<string, unknown>)?.data_root as string ?? ".embed-agent";
  const log = new Logger({ module: "embed-agent", minLevel: "info" });

  const eventStore = new EventStore(dataRoot);
  const evidenceStore = new EvidenceStore(dataRoot, { emit: async () => {} });
  const runStore = new RunStore(dataRoot, log);
  const targetStore = new TargetStore(dataRoot);
  const memoryStore = new MemoryStore(dataRoot);

  // 3. Create EventBus
  const eventBus = new EventBus();

  // 4. Wire EventBus → EventStore persistence
  eventStore.subscribeToBus(eventBus, runStore);

  // 5. Load prompts
  const promptLoader = new PromptLoader(`${dataRoot}/prompts`);
  let prompts: { planner?: string; observer?: string } | undefined;
  try {
    const set = await promptLoader.loadAll("1");
    const plannerPrompt = set.get("planner")?.system;
    const observerPrompt = set.get("observer")?.system;
    if (plannerPrompt || observerPrompt) {
      prompts = {};
      if (plannerPrompt) prompts.planner = plannerPrompt;
      if (observerPrompt) prompts.observer = observerPrompt;
    }
    log.info("Prompts loaded from files");
  } catch {
    log.info("Using built-in prompts (no prompt files found)");
  }

  // 6. Create ContextAssembler
  const contextAssembler = new ContextAssembler(
    runStore, eventStore, targetStore, memoryStore, prompts,
  );

  // 7. Create stubs for agent layer (full wiring requires agent package)
  const stubPlanner = { call: async () => ({ status: "clarification_needed" as const, missing_info: ["no LLM configured"], suggested_next: "configure LLM" }) };
  const stubReply = {
    generate: async () => ({ run_id: "", status: "completed" as const, summary: "", suggested_next: "", evidence_path: "", key_evidence: [], confidence: 0 }),
    generateMinimal: async () => ({ run_id: "", status: "failed" as const, summary: "", suggested_next: "", evidence_path: "", key_evidence: [], confidence: 0 }),
    generateCancelled: async () => ({ run_id: "", status: "cancelled" as const, summary: "", suggested_next: "", evidence_path: "", key_evidence: [], confidence: 0 }),
  };

  // 8. Create RunManager (deferred — requires full agent wiring)
  // For now, create CommandHandler with views-only query support
  const handler = new CommandHandler(
    null as never, // Will be replaced when full wiring is done
    null as never,
  );

  log.info("Bootstrap complete");

  return {
    handler,
    logger: log,
    shutdown: async () => {
      log.info("Shutting down");
    },
  };
}

// Auto-run if executed directly
const isMain = process.argv[1]?.includes("bootstrap");
if (isMain) {
  bootstrap().then(({ handler }) => runCli(handler)).catch((e) => {
    process.stderr.write(`Bootstrap failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
