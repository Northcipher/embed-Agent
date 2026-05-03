// CLI entry point — runtime commands are thin HTTP clients. The HTTP Runtime owns active state.
import { bootstrap } from "./bootstrap.js";
import { runCli } from "./cli.js";
import { HttpCommandHandler } from "./http-client.js";

function parseEntryOptions(argv: string[]): {
  argv: string[];
  serverUrl: string;
  localRuntime: boolean;
} {
  const out: string[] = [];
  let serverUrl = process.env["EMBED_AGENT_SERVER_URL"] ?? "http://127.0.0.1:8787";
  let localRuntime = process.env["EMBED_AGENT_CLI_MODE"] === "local";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--local-runtime") {
      localRuntime = true;
      continue;
    }
    if (arg === "--server") {
      const next = argv[i + 1];
      if (next) {
        serverUrl = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--server=")) {
      serverUrl = arg.slice("--server=".length);
      continue;
    }
    out.push(arg);
  }

  return { argv: out, serverUrl, localRuntime };
}

function detectCommand(argv: string[]): string {
  return argv.find(arg => !arg.startsWith("-")) ?? "help";
}

const HTTP_RUNTIME_COMMANDS = new Set([
  "validate",
  "status",
  "events",
  "watch",
  "result",
  "evidence",
  "pause",
  "resume",
  "cancel",
  "intervene",
  "targets",
  "target",
  "history",
]);

const LOCAL_STORE_COMMANDS = new Set([
  "task",
  "memory",
  "skill",
  "hook",
]);

async function main(): Promise<void> {
  const entry = parseEntryOptions(process.argv.slice(2));
  const command = detectCommand(entry.argv);

  if (!entry.localRuntime && (HTTP_RUNTIME_COMMANDS.has(command) || !LOCAL_STORE_COMMANDS.has(command))) {
    await runCli(new HttpCommandHandler(entry.serverUrl) as never, entry.argv);
    return;
  }

  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  try {
    ctx = await bootstrap();
  } catch (e) {
    // Config missing or LLM provider unavailable — start in query-only mode
    process.stderr.write(`Bootstrap unavailable: ${(e as Error).message}\n`);
    process.stderr.write("Starting in query-only mode (validate/pause/resume/cancel unavailable)\n\n");

    // Dynamic import to avoid type issues when stores aren't fully available
    const { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, SkillStore, TaskStore, Logger } = await import("@embed-agent/stores");
    const { Views } = await import("@embed-agent/views");
    const { CommandHandler } = await import("./command-handler.js");

    const dataRoot = process.env["EMBED_AGENT_DATA"] ?? ".embed-agent";
    const log = new Logger({ module: "cli" });
    const runStore = new RunStore(dataRoot, log);
    const targetStore = new TargetStore(dataRoot);
    const memoryStore = new MemoryStore(dataRoot);
    const skillStore = new SkillStore(dataRoot);
    const taskStore = new TaskStore(dataRoot);
    const eventStore = new EventStore(dataRoot);

    await skillStore.loadAll().catch(() => {});
    const views = new Views(runStore, eventStore, new EvidenceStore(dataRoot), targetStore, memoryStore);
    const handler = new CommandHandler(null as never, views);

    // Query-mode guard for mutation commands
    handler.validate = async () => ({ status: "error", reasons: ["RunManager not available — check config and LLM credentials"] }) as any;
    handler.pause = async () => ({ accepted: false, run_id: "", status: "error", error_code: "internal_error", message: "RunManager not available" }) as any;
    handler.resume = async () => ({ accepted: false, run_id: "", status: "error", error_code: "internal_error", message: "RunManager not available" }) as any;
    handler.cancel = async () => ({ accepted: false, run_id: "", status: "error", error_code: "internal_error", message: "RunManager not available" }) as any;

    handler.skillList = async () => ({ skills: skillStore.list().map(s => ({ name: s.name, description: s.description, category: s.category })), status: "ok" } as any);
    handler.taskList = async () => ({ tasks: (await taskStore.list()).map(t => ({ name: t.name, skill: t.skill, enabled: t.enabled })), status: "ok" } as any);
    handler.hookList = async () => ({ hooks: [] as { name: string; on: string }[], status: "ok" } as any);
    handler.memoryList = async (targetId?: string, category?: string) => {
      try {
        const facts = await memoryStore.queryFacts("target", targetId ?? "", category);
        const entries = facts.filter((f: { statement: string }) => f.statement !== "__DELETED__").map((f: { fact_id: string; category: string; statement: string; verified: boolean }) => ({ fact_id: f.fact_id, category: f.category, statement: f.statement, verified: f.verified }));
        return { entries, status: "ok" } as any;
      } catch { return { entries: [] as { fact_id: string; category: string; statement: string; verified: boolean }[], status: "ok" } as any; }
    };

    await runCli(handler, entry.argv);
    return;
  }

  await runCli(ctx.handler, entry.argv);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
