import { ConfigLoader, Logger, PromptLoader, EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, SkillStore } from "@embed-agent/stores";
import { EventBus, ContextAssembler, RunManager, HookManager, StepExecutor, DecisionHandler } from "@embed-agent/runtime";
import { ConnectionManager, TargetManager, OutputPipe, RingBuffer, RuleDetector, Aggregator } from "@embed-agent/tools";
import { LLMCallManager, MockProvider, AIAnthropicProvider, AIOpenAIProvider, AIOpenAICompatibleProvider, DeepSeekProvider, DeepSeekOpenAIProvider, type LLMProvider, Planner, Observer, ReplyGenerator, Memory, SkillRegistry, createPlannerTools } from "@embed-agent/agent";
import { NotificationFilter, LogChannel } from "@embed-agent/notify";
import { Views } from "@embed-agent/views";
import { SystemConfigSchema, LLMConfigSchema, HookConfigSchema, TargetProfileSchema } from "@embed-agent/contracts";
import { CommandHandler } from "./command-handler.js";
import { runCli } from "./cli.js";

export interface BootstrapResult {
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
  // llm.yml is required — failures block startup
  errors.push(...llmErrors);

  // Load target profiles
  const { configs: targetConfigs, errors: targetErrors } = await loader.loadAll({
    "targets.yml": { schema: TargetProfileSchema, required: false },
  });
  // Optional configs: log warnings but don't block startup
  for (const e of targetErrors) {
    logger.warn(`Optional config skipped: ${e.file}: ${e.message}`);
  }

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
  // Register targets from config
  const targetRaw = targetConfigs["targets"];
  const targetList = Array.isArray(targetRaw) ? targetRaw as Record<string, unknown>[] : targetRaw ? [targetRaw as Record<string, unknown>] : [];
  for (const t of targetList) {
    await targetStore.add(t as never).catch((e) => log.warn(`Failed to add target: ${(e as Error).message}`));
  }

  const memoryStore = new MemoryStore(dataRoot);
  // 3. Create EventBus + wire persistence
  const eventBus = new EventBus();
  // EvidenceStore with EventBus for evidence_collected events
  const evidenceStore = new EvidenceStore(dataRoot, { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } });
  eventStore.subscribeToBus(eventBus, runStore, evidenceStore);

  // 4. Create LLM provider — config-driven, fallback to MockProvider for dev
  const llmCfg = llmConfigs["llm"] as Record<string, unknown> | undefined;
  const providers = llmCfg?.providers as Record<string, Record<string, unknown>> | undefined;
  const defaultProvider = llmCfg?.default_provider as string ?? "mock";
  const providerCfg = providers?.[defaultProvider];
  const providerType = (providerCfg?.type as string) ?? "mock";
  const providerApiKeyEnv = providerCfg?.api_key_env as string | undefined;
  const providerBaseUrl = providerCfg?.base_url as string | undefined;
  const providerApiKey = providerApiKeyEnv ? (process.env[providerApiKeyEnv] ?? "") : "";

  let llmProvider: LLMProvider;
  if (providerType === "mock" || !providerCfg || !providerApiKey) {
    const mock = new MockProvider();
    mock.setResponse(JSON.stringify({
      plan_id: "default", estimated_duration_sec: 300,
      steps: [{ id: "check", capability: "shell_exec", action: "exec", command: "uname -a", timeout_sec: 60 }],
      evidence_policy: { always: ["serial:full"], on_failure: ["logcat"] },
      success_criteria: ["device responds to shell"], failure_signals: ["kernel panic"],
    }));
    llmProvider = mock;
    if (providerType !== "mock" && !providerApiKey) {
      log.warn(`${providerApiKeyEnv} not set — using MockProvider`);
    }
  } else if (providerType === "anthropic") {
    llmProvider = new AIAnthropicProvider(providerApiKey, providerBaseUrl);
    const am = (providerCfg?.models as Record<string, string> | undefined);
    log.info(`LLM: Anthropic (${am?.["planner"] ?? "?"})${providerBaseUrl ? ` @ ${providerBaseUrl}` : ""}`);
  } else if (providerType === "openai") {
    llmProvider = new AIOpenAIProvider(providerApiKey, providerBaseUrl);
    const om = (providerCfg?.models as Record<string, string> | undefined);
    log.info(`LLM: OpenAI (${om?.["planner"] ?? "?"})`);
  } else if (providerType === "openai-compatible") {
    if (!providerBaseUrl) {
      logger.error("openai-compatible provider requires base_url in llm.yml");
      process.exit(1);
    }
    llmProvider = new AIOpenAICompatibleProvider(providerBaseUrl, providerApiKey);
    log.info(`LLM: OpenAI-compatible @ ${providerBaseUrl}`);
  } else if (providerType === "deepseek") {
    llmProvider = new DeepSeekProvider(providerApiKey, providerBaseUrl);
    log.info(`LLM: DeepSeek Anthropic-compatible${providerBaseUrl ? ` @ ${providerBaseUrl}` : ""}`);
  } else if (providerType === "deepseek-openai") {
    llmProvider = new DeepSeekOpenAIProvider(providerApiKey, providerBaseUrl);
    log.info(`LLM: DeepSeek OpenAI-compatible${providerBaseUrl ? ` @ ${providerBaseUrl}` : ""}`);
  } else {
    logger.error(`Unknown LLM provider type: ${providerType}`);
    process.exit(1);
  }

  // Read model names and timeouts from LLM config
  const models = {
    planner: { model: (providerCfg?.models as Record<string, string> | undefined)?.["planner"] ?? "", timeout: (providerCfg?.timeout as Record<string, number> | undefined)?.["planner"] ?? 120 },
    observer: { model: (providerCfg?.models as Record<string, string> | undefined)?.["observer"] ?? "", timeout: (providerCfg?.timeout as Record<string, number> | undefined)?.["observer"] ?? 60 },
    reply: { model: (providerCfg?.models as Record<string, string> | undefined)?.["reply"] ?? "", timeout: (providerCfg?.timeout as Record<string, number> | undefined)?.["reply"] ?? 60 },
  };
  if (!models.planner.model || !models.observer.model || !models.reply.model) {
    logger.error("llm.yml must specify models for planner, observer, and reply");
    process.exit(1);
  }

  // Wire observer CB4 config from system.yml
  const obsCfg = (systemConfig?.observer as Record<string, unknown>);
  const cb4Cfg = obsCfg?.circuit_breaker as Record<string, unknown> | undefined;
  const cbConfig = {
    maxFailures: (cb4Cfg?.max_failures as number) ?? 3,
    probeAfterSec: (cb4Cfg?.probe_after_sec as number) ?? 300,
  };
  const llm = new LLMCallManager(llmProvider, models, { maxRetries: 2 }, cbConfig);

  // 5. Load prompts — version from config, fallback to "1"
  const promptVersion = (systemConfig?.prompt_version as string) ?? "1";
  const promptLoader = new PromptLoader(`config/prompts`);
  let prompts: { planner?: string; observer?: string; reply?: string } | undefined;
  try {
    const set = await promptLoader.loadAll(promptVersion);
    const pp = set.get("planner")?.system;
    const op = set.get("observer")?.system;
    const rp = set.get("reply")?.system;
    if (pp || op || rp) { prompts = {}; if (pp) prompts.planner = pp; if (op) prompts.observer = op; if (rp) prompts.reply = rp; }
    log.info(`Prompts loaded: version=${promptVersion}, roles=${[...set.keys()].join(",")}`);
  } catch {
    // Fallback: try v1
    try {
      const set = await promptLoader.loadAll("1");
      const pp = set.get("planner")?.system;
      const op = set.get("observer")?.system;
      const rp = set.get("reply")?.system;
      if (pp || op || rp) { prompts = {}; if (pp) prompts.planner = pp; if (op) prompts.observer = op; if (rp) prompts.reply = rp; }
      log.warn(`Prompt version "${promptVersion}" not found, fell back to v1`);
    } catch { /* use built-in defaults */ }
  }

  // 6. Agent layer
  const memory = new Memory(memoryStore);

  // Planner tools: device inspection queries (FREE, no LLM calls)
  // SkillStore must be created before plannerTools for searchSkills tool
  const skillStore = new SkillStore(dataRoot);
  const plannerTools = createPlannerTools({
    targets: { getState: (id) => targetStore.getState?.(id) ?? null, get: (id) => targetStore.get(id) },
    memory: memoryStore,
    skills: skillStore,
  });

  const planner = new Planner(llm, { emit: async (e) => { await eventBus.emit(e); } }, plannerTools, 5);
  const reply = new ReplyGenerator(llm, eventStore, evidenceStore, runStore,
    memoryStore as never /* MemoryStore satisfies MemoryWriter at runtime */,
    { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } }, dataRoot,
    prompts?.reply,
  );

  // 7. Tool layer — pass security policy from system config
  const secCfg = systemConfig?.security as Record<string, unknown> | undefined;
  const cm = new ConnectionManager(
    { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } },
    targetStore,
    { allowed_commands: (secCfg?.allowed_shell_commands as string[]) ?? [] },
  );
  const tm = new TargetManager(cm, targetStore);

  // 8. Runtime layer — load hooks config
  const { configs: hookConfigs } = await loader.loadAll({
    "hooks.yml": { schema: HookConfigSchema, required: false },
  });
  const hooksConfig = hookConfigs["hooks"] as { hooks: { name: string; on: string; command: string; timeout: number }[] } | undefined;
  const hooks = (hooksConfig?.hooks ?? []) as never[];
  const hm = new HookManager(hooks as never, { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } });

  // Create SkillRegistry + load skills (skillStore created above for plannerTools)
  const skillRegistry = new SkillRegistry(skillStore);
  await skillRegistry.loadAll().catch(() => {});

  // Wire Observer Memory
  const observerInst = new Observer(llm, memory, { emit: async (e: Record<string, unknown>) => { await eventBus.emit(e); } });

  const contextAssembler = new ContextAssembler(runStore, eventStore, targetStore, memoryStore, evidenceStore, skillRegistry, prompts);

  // Adapters: bridge Agent types to RunManager's DI interfaces
  const plannerAdapter = { call: async (sp: string, fc: string, runId?: string) => planner.call(sp, fc, runId) };
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

    // Per-run Aggregator — shared across all steps, accumulates stage/pattern/baseline state
    const ag = new Aggregator(eventBus);
    ag.setRunId(runId);

    // Start periodic checkpoint timer (DecisionHandler subscribes to checkpoint events)
    const checkpointMs = ((systemConfig?.observer as Record<string, unknown>)?.default_checkpoint_interval_sec as number ?? 300) * 1000;
    const checkpointTimer = setInterval(() => { ag.checkpoint().catch(() => {}); }, checkpointMs);
    rm.checkpointTimers.set(runId, checkpointTimer);

    // Per-step OutputPipe factory: creates RuleDetector + RingBuffer per step, shares Aggregator
    const pipeFactory = (stepId: string) => {
      const ringCfg = (systemConfig?.runtime as Record<string, unknown>)?.ring_buffer as Record<string, unknown> | undefined;
      const rb = new RingBuffer((ringCfg?.max_lines as number) ?? 500);
      const evidenceSaver = { saveWindow: (rid: string, ref: string, data: string) => evidenceStore.write(rid, ref, data).then(() => {}) };
      const rd = new RuleDetector(rb, eventBus, evidenceSaver, runId);
      rd.setStepId?.(stepId);

      // Load rules from config
      const sysRules = (systemConfig?.runtime as Record<string, unknown>)?.rule_policy as Record<string, unknown>;
      const fatalPatterns = (sysRules?.fatal_patterns as string[]) ?? [];
      const warnPatterns = (sysRules?.warning_patterns as string[]) ?? [];
      rd.loadRunRules(
        fatalPatterns.map(p => ({ id: p.slice(0, 20), kind: "pattern" as const, pattern: new RegExp(p), severity: "fatal" as const, source: "system" as const, debounce_sec: 30 })),
        warnPatterns.map(p => ({ id: p.slice(0, 20), kind: "pattern" as const, pattern: new RegExp(p), severity: "warning" as const, source: "system" as const, debounce_sec: 30 })),
        [],
      );

      const ew = {
        append: (d: string) => evidenceStore.append(runId, `step-${stepId}:full`, d),
      };

      const silenceMs = ((sysRules?.silence_timeout_sec as number) ?? 60) * 1000;
      const pipe = new OutputPipe(ew, rb, rd, ag, eventBus, stepId, silenceMs);
      pipe.setRunId(runId);
      return pipe;
    };

    // Wire retry config from system.yml
    const rtCfg = (systemConfig?.runtime as Record<string, unknown>)?.retry as Record<string, unknown> | undefined;
    const retryConfig = rtCfg ? {
      maxRetries: rtCfg.max_retries as number,
      intervals: rtCfg.intervals_sec as number[],
      retryable: rtCfg.retryable as string[],
    } : undefined;
    return new StepExecutor(runId, target, eventBus, hm, cm, pipeFactory, retryConfig);
  });
  rm.setDecisionHandlerFactory((runId: string) => {
    const obsDebounceSec = (obsCfg?.debounce_sec as number) ?? 30;
    // Share ignored rules across DecisionHandler instances within the same run
    let ignoredRules = rm.ignoredRules.get(runId);
    if (!ignoredRules) { ignoredRules = new Set(); rm.ignoredRules.set(runId, ignoredRules); }
    return new DecisionHandler(
      eventBus, hm,
      { decide: async (sp: string, fc: string, rid?: string) => observerInst.decide(sp, fc, rid) },
      { pause: (rid, r) => rm.pause(rid, r), cancel: (rid, r) => rm.cancel(rid, r), stopRun: (rid, r) => rm.stopRun(rid, r), appendStep: (rid, s) => rm.appendStep(rid, s) },
      { assembleObserverContext: async (rid: string, event: Record<string, unknown>, cbActive: boolean, warnEsc: boolean) => {
        const ctx = await contextAssembler.assembleObserverContext(rid, event as never, cbActive, warnEsc);
        const result: { staticPrompt: string; formattedContext: string; knownIssues?: { fact_id: string; category: string; statement: string; extended_pattern?: string }[] } = { staticPrompt: ctx.staticPrompt, formattedContext: ctx.formattedContext };
        if (ctx.knownIssues) result.knownIssues = ctx.knownIssues;
        return result;
      }},
      obsDebounceSec,
      ignoredRules,
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
  const handler = new CommandHandler(rm, views, memoryStore, skillStore as never, eventBus);

  // Recover from previous crash — stale runs + lock cleanup
  rm.setEventReader?.({ read: (rid: string, afterSeq?: number, limit?: number) => eventStore.read(rid, afterSeq, limit) });
  await rm.recoverOnStartup().catch((e) => log.warn(`Crash recovery failed: ${(e as Error).message}`));

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
