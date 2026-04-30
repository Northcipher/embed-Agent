import { ConfigLoader, Logger, PromptLoader, EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, SkillStore } from "@embed-agent/stores";
import { EventBus, ContextAssembler, RunManager, HookManager, StepExecutor, DecisionHandler } from "@embed-agent/runtime";
import { ConnectionManager, TargetManager, OutputPipe, RingBuffer, RuleDetector, Aggregator } from "@embed-agent/tools";
import { LLMCallManager, MockProvider, AnthropicProvider, Planner, Observer, ReplyGenerator, Memory, SkillRegistry } from "@embed-agent/agent";
import { NotificationFilter, LogChannel } from "@embed-agent/notify";
import { Views } from "@embed-agent/views";
import { SystemConfigSchema, LLMConfigSchema } from "@embed-agent/contracts";
import { CommandHandler } from "./command-handler.js";
import { runCli } from "./cli.js";
import fs from "node:fs/promises";
import path from "node:path";

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

  // 1. Load configs with real Zod schema validation
  const loader = new ConfigLoader(configRoot, logger);
  const { configs, errors } = await loader.loadAll({
    "system.yml": { schema: SystemConfigSchema, required: true },
  });

  // Model config validation
  const { configs: llmConfigs, errors: llmErrors } = await loader.loadAll({
    "llm.yml": { schema: LLMConfigSchema, required: true },
  });
  errors.push(...llmErrors);

  if (errors.length > 0) {
    logger.error("Config validation failed", { errors });
    for (const e of errors) process.stderr.write(`  ${e.file}: ${e.message}\n`);
    process.exit(1);
  }

  // 2. Create stores
  const systemConfig = configs["system"] as Record<string, unknown> | undefined;
  const dataRoot = (systemConfig?.storage as Record<string, unknown>)?.data_root as string ?? ".embed-agent";
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

  // Read model names from LLM config — required, no defaults
  const llmCfg = llmConfigs["llm"] as Record<string, unknown> | undefined;
  const providers = llmCfg?.providers as Record<string, Record<string, unknown>> | undefined;
  const defaultProvider = llmCfg?.default_provider as string ?? "anthropic";
  const providerCfg = providers?.[defaultProvider];
  if (!providerCfg?.models) {
    logger.error("LLM models not configured. Set providers.<name>.models in llm.yml");
    process.exit(1);
  }
  const models = {
    planner: { model: (providerCfg.models as Record<string, string>).planner!, timeout: 120 },
    observer: { model: (providerCfg.models as Record<string, string>).observer!, timeout: 60 },
    reply: { model: (providerCfg.models as Record<string, string>).reply!, timeout: 60 },
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

  // 7. Tool layer — pass security policy from system config
  const secCfg = systemConfig?.security as Record<string, unknown> | undefined;
  const cm = new ConnectionManager(
    { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } },
    targetStore,
    { allowed_commands: (secCfg?.allowed_shell_commands as string[]) ?? [] },
  );
  const tm = new TargetManager(cm, targetStore);

  // 8. Runtime layer
  const hm = new HookManager([], { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } });

  // Create SkillRegistry + load skills
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

  // Inject executor/decision-handler factories — fully wired
  rm.setExecutorFactory(async (runId: string, targetId: string) => {
    const profile = await targetStore.get(targetId);
    const target = profile ?? { target_id: targetId, connections: {} as Record<string, unknown> };

    // Per-step OutputPipe factory: creates RuleDetector + Aggregator + RingBuffer pipeline
    const pipeFactory = (stepId: string) => {
      const rb = new RingBuffer(500);
      // EvidenceStore adapter: RuleDetector expects saveWindow, EvidenceStore provides write
      const evidenceSaver = { saveWindow: (rid: string, ref: string, data: string) => evidenceStore.write(rid, ref, data).then(() => {}) };
      const rd = new RuleDetector(rb, eventBus, evidenceSaver, runId);
      // Load system rules from config
      const sysRules = (systemConfig?.runtime as Record<string, unknown>)?.rule_policy as Record<string, unknown>;
      const fatalPatterns = (sysRules?.fatal_patterns as string[]) ?? [];
      const warnPatterns = (sysRules?.warning_patterns as string[]) ?? [];
      rd.loadRunRules(
        fatalPatterns.map(p => ({ id: p.slice(0, 20), kind: "pattern" as const, pattern: new RegExp(p), severity: "fatal" as const, source: "system" as const, debounce_sec: 30 })),
        warnPatterns.map(p => ({ id: p.slice(0, 20), kind: "pattern" as const, pattern: new RegExp(p), severity: "warning" as const, source: "system" as const, debounce_sec: 30 })),
        [],
      );

      const ag = new Aggregator(eventBus);
      // Boot markers loaded from target profile on first step (see connection setup)

      // EvidenceWriter: appends to step evidence file
      const evFile = path.join(dataRoot, "runs", runId, `${stepId}.log`);
      const ew = { append: (d: string) => { fs.appendFile(evFile, d).catch(() => {}); } };

      const pipe = new OutputPipe(ew, rb, rd, ag, eventBus, stepId);
      pipe.setRunId(runId);
      return pipe;
    };

    return new StepExecutor(runId, target, eventBus, hm, cm, pipeFactory);
  });
  rm.setDecisionHandlerFactory((runId: string) => {
    return new DecisionHandler(
      eventBus, hm,
      { decide: async (sp: string, input: Record<string, unknown>) => observerInst.decide(sp, input as never, runId) },
      { pause: (rid, r) => rm.pause(rid, r), cancel: (rid, r) => rm.cancel(rid, r), stopRun: (rid, r) => rm.stopRun(rid, r), appendStep: (rid, s) => rm.appendStep(rid, s) },
      { assembleObserverContext: async (rid: string, event: Record<string, unknown>, cbActive: boolean, warnEsc: boolean) => {
        const ctx = await contextAssembler.assembleObserverContext(rid, event as never, cbActive, warnEsc);
        return { staticPrompt: ctx.staticPrompt, input: ctx.input as Record<string, unknown> };
      }},
    );
  });

  // 9. Views
  const views = new Views(runStore, eventStore, evidenceStore, targetStore, memoryStore);

  // 10. NotificationFilter — subscribe to EventBus for result/target/suggestion events
  const notifyChannel = new LogChannel();
  const notifyFilter = new NotificationFilter(
    { subscribe: (ts, h) => eventBus.subscribe(ts, h), emit: async (e) => { await eventBus.emit(e); } },
    { slack: notifyChannel, log: notifyChannel },
  );
  notifyFilter.start();

  // 11. CommandHandler — fully wired
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
