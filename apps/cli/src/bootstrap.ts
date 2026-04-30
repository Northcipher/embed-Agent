import { ConfigLoader, Logger, PromptLoader, EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore } from "@embed-agent/stores";
import { EventBus, ContextAssembler, RunManager, HookManager } from "@embed-agent/runtime";
import { ConnectionManager, TargetManager } from "@embed-agent/tools";
import { LLMCallManager, MockProvider, AnthropicProvider, Planner, Observer, ReplyGenerator, Memory } from "@embed-agent/agent";
import { Views } from "@embed-agent/views";
import { CommandHandler } from "./command-handler.js";
import { runCli } from "./cli.js";

interface BootstrapResult {
  handler: CommandHandler;
  logger: Logger;
  shutdown: () => Promise<void>;
}

/**
 * Production bootstrap: loads config, creates all services, wires them together.
 * Uses AnthropicProvider if ANTHROPIC_API_KEY is set, otherwise MockProvider for dev.
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
    for (const e of errors) process.stderr.write(`  ${e.file}: ${e.message}\n`);
    process.exit(1);
  }

  // 2. Create stores
  const dataRoot = (configs["system"] as Record<string, unknown>)?.data_root as string ?? ".embed-agent";
  const log = new Logger({ module: "embed-agent", minLevel: "info" });

  const eventStore = new EventStore(dataRoot);
  const runStore = new RunStore(dataRoot, log);
  const targetStore = new TargetStore(dataRoot);
  const memoryStore = new MemoryStore(dataRoot);
  const evidenceStore = new EvidenceStore(dataRoot);

  // 3. Create EventBus + wire persistence
  const eventBus = new EventBus();
  eventStore.subscribeToBus(eventBus, runStore);

  // 4. Create LLM (Anthropic if key set, Mock for dev)
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const llmProvider = apiKey
    ? new AnthropicProvider(apiKey)
    : new MockProvider();
  if (!apiKey) {
    (llmProvider as MockProvider).setResponse(JSON.stringify({
      plan_id: "default", estimated_duration_sec: 300,
      steps: [{ id: "check", capability: "shell_exec", action: "exec", command: "uname -a", timeout_sec: 60 }],
      evidence_policy: { always: ["serial:full"], on_failure: ["logcat"] },
      success_criteria: ["device responds to shell"], failure_signals: ["kernel panic"],
    }));
    log.warn("No ANTHROPIC_API_KEY set — using MockProvider for LLM calls");
  }

  // Read model names from system config, fall back to defaults
  const llmConfig = (configs["system"] as Record<string, unknown>);
  const models = {
    planner: { model: (llmConfig?.models as Record<string, string>)?.planner ?? "claude-sonnet-4-6", timeout: 120 },
    observer: { model: (llmConfig?.models as Record<string, string>)?.observer ?? "claude-haiku-4-5", timeout: 60 },
    reply: { model: (llmConfig?.models as Record<string, string>)?.reply ?? "claude-haiku-4-5", timeout: 60 },
  };

  const llm = new LLMCallManager(llmProvider, models);

  // 5. Load prompts
  const promptLoader = new PromptLoader(`${dataRoot}/prompts`);
  let prompts: { planner?: string; observer?: string } | undefined;
  try {
    const set = await promptLoader.loadAll("1");
    const pp = set.get("planner")?.system;
    const op = set.get("observer")?.system;
    if (pp || op) { prompts = {}; if (pp) prompts.planner = pp; if (op) prompts.observer = op; }
  } catch { /* use built-in defaults */ }

  // 6. Agent layer
  const memory = new Memory(memoryStore);
  const planner = new Planner(llm, { emit: async (e) => { await eventBus.emit(e); } });
  const reply = new ReplyGenerator(llm, eventStore, evidenceStore, runStore,
    memoryStore as never /* MemoryStore satisfies MemoryWriter at runtime */,
    { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } }, dataRoot,
  );

  // 7. Tool layer
  const cm = new ConnectionManager(
    { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } },
    targetStore,
  );
  const tm = new TargetManager(cm, targetStore);

  // 8. Runtime layer
  const hm = new HookManager([], { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } });

  // Create SkillRegistry + load skills
  const { SkillStore } = await import("@embed-agent/stores");
  const { SkillRegistry } = await import("@embed-agent/agent");
  const skillStore = new SkillStore(dataRoot);
  const skillRegistry = new SkillRegistry(skillStore);
  await skillRegistry.loadAll().catch(() => {});

  // Wire Observer Memory
  const observerInst = new Observer(llm, memory);

  const contextAssembler = new ContextAssembler(runStore, eventStore, targetStore, memoryStore, skillRegistry, prompts);

  // Adapters: bridge Agent types to RunManager's DI interfaces
  const plannerAdapter = { call: async (sp: string, dc: Record<string, unknown>, runId?: string) => planner.call(sp, dc as never, runId) };
  const replyAdapter = {
    generate: (rid: string) => reply.generate(rid),
    generateMinimal: (rid: string, reason: string) => reply.generateMinimal(rid, reason),
    generateCancelled: (rid: string, reason: string) => reply.generateCancelled(rid, reason),
  };

  const rm = new RunManager(runStore, targetStore, tm, eventBus, hm, contextAssembler, plannerAdapter, replyAdapter, dataRoot);

  // 9. Views
  const views = new Views(runStore, eventStore, evidenceStore, targetStore, memoryStore);

  // 10. CommandHandler — fully wired
  const handler = new CommandHandler(rm, views);

  log.info("Bootstrap complete — Embed Agent ready");

  return {
    handler,
    logger: log,
    shutdown: async () => { log.info("Shutting down"); },
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
