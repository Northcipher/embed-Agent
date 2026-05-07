// Shared server startup — used by CLI and MCP to auto-start HTTP Runtime.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8787";

export interface ServerRuntimeLayout {
  cliDir: string;
  serverCwd: string;
  serverEntry: string;
  defaultDataDir: string;
  defaultWebDist: string;
  nodeBinary: string;
}

export function resolveServerRuntimeLayout(
  cliModulePath = fileURLToPath(import.meta.url),
  env: NodeJS.ProcessEnv = process.env,
): ServerRuntimeLayout {
  const cliDir = path.dirname(cliModulePath);
  const repoRoot = path.resolve(cliDir, "../../..");
  const runtimeRoot = env["EMBED_AGENT_RUNTIME_ROOT"]
    ? path.resolve(env["EMBED_AGENT_RUNTIME_ROOT"])
    : undefined;

  return {
    cliDir,
    serverCwd: runtimeRoot ?? repoRoot,
    serverEntry: env["EMBED_AGENT_SERVER_ENTRY"]
      ? path.resolve(env["EMBED_AGENT_SERVER_ENTRY"])
      : path.resolve(cliDir, "../../http-server/dist/main.js"),
    defaultDataDir: env["EMBED_AGENT_DATA"]
      ?? (runtimeRoot ? path.join(runtimeRoot, "data") : path.join(repoRoot, ".embed-agent")),
    defaultWebDist: env["EMBED_AGENT_WEB_DIST"]
      ?? (runtimeRoot ? path.join(runtimeRoot, "webui") : path.join(repoRoot, "apps/webui/dist")),
    nodeBinary: env["EMBED_AGENT_NODE_BINARY"] ?? process.execPath,
  };
}

export async function isServerRunning(url = DEFAULT_URL): Promise<boolean> {
  try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

async function ensureFileIfMissing(targetPath: string, content: string): Promise<void> {
  try {
    await readFile(targetPath, "utf8");
  } catch {
    await writeFile(targetPath, content, "utf8");
  }
}

async function ensureDefaultConfig(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });

  const normalizedDataDir = JSON.stringify(dataDir.replaceAll("\\", "/"));
  await ensureFileIfMissing(path.join(dataDir, "system.yml"), [
    "runtime:",
    "  retry:",
    "    max_retries: 3",
    "    intervals_sec: [2, 5, 10]",
    "    retryable: [\"timeout\", \"connection_lost\"]",
    "  rule_policy:",
    "    fatal_patterns: [\"Kernel panic\", \"Watchdog reset\"]",
    "    warning_patterns: [\"error\", \"FAILED\"]",
    "    silence_timeout_sec: 60",
    "  ring_buffer:",
    "    max_lines: 500",
    "    default_before: 200",
    "    default_after: 80",
    "  step_executor:",
    "    max_timeout_sec: 3600",
    "    default_timeout_sec: 60",
    "storage:",
    `  data_root: ${normalizedDataDir}`,
    "  max_evidence_bytes: 104857600",
    "  cleanup:",
    "    keep_completed_days: 30",
    "    keep_failed_days: 90",
    "    max_episodes_per_target: 100",
    "notifications:",
    "  enabled: false",
    "security:",
    "  allowed_shell_commands: [\"echo\", \"uname\", \"dmesg\", \"cat\", \"true\", \"false\"]",
    "  max_command_length: 4096",
    "  block_unsafe_patterns: true",
    "observer:",
    "  debounce_sec: 30",
    "  max_concurrent_per_run: 1",
    "  default_checkpoint_interval_sec: 300",
    "  circuit_breaker:",
    "    max_failures: 3",
    "    probe_after_sec: 300",
    "  warning_escalation:",
    "    threshold: 5",
    "    window_sec: 300",
    "prompt_version: \"1\"",
    "",
  ].join("\n"));

  await ensureFileIfMissing(path.join(dataDir, "llm.yml"), [
    "default_provider: mock",
    "providers:",
    "  mock:",
    "    type: mock",
    "    api_key_env: EMBED_AGENT_UNUSED",
    "    models:",
    "      planner: mock",
    "      observer: mock",
    "      reply: mock",
    "    timeout:",
    "      planner: 120",
    "      observer: 60",
    "      reply: 60",
    "",
  ].join("\n"));

  await ensureFileIfMissing(path.join(dataDir, "targets.yml"), "[]\n");
}

export async function ensureServer(url = DEFAULT_URL): Promise<void> {
  if (await isServerRunning(url)) return;
  const port = String(new URL(url).port || 8787);
  const runtime = resolveServerRuntimeLayout();
  await ensureDefaultConfig(runtime.defaultDataDir);
  const proc = spawn(runtime.nodeBinary, [runtime.serverEntry], {
    cwd: runtime.serverCwd,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      PORT: port,
      HOST: new URL(url).hostname || "127.0.0.1",
      EMBED_AGENT_DATA: runtime.defaultDataDir,
      EMBED_AGENT_WEB_DIST: runtime.defaultWebDist,
      EMBED_AGENT_SERVER_URL: process.env["EMBED_AGENT_SERVER_URL"] ?? url,
    },
  });
  proc.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await isServerRunning(url)) return; await new Promise(r => setTimeout(r, 500)); }
  try { proc.kill(); } catch {}
  throw new Error(`Runtime server failed to start at ${url}. Check llm.yml config.`);
}
