import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(scriptDir, "..");
export const dataDir = path.join(repoRoot, ".embed-agent");
export const logDir = path.join(dataDir, "logs");
export const serverLogFile = path.join(logDir, "http-server.log");
export const serverUrl = process.env["EMBED_AGENT_SERVER_URL"] ?? "http://127.0.0.1:8787";
export const webUrl = `${serverUrl}/#/start`;
export const httpServerEntry = path.join(repoRoot, "apps/http-server/dist/main.js");
export const cliEntry = path.join(repoRoot, "apps/cli/dist/main.js");
export const mcpEntry = path.join(repoRoot, "apps/mcp-server/dist/main.js");
export const webDistDir = path.join(repoRoot, "apps/webui/dist");
export const systemConfigPath = path.join(dataDir, "system.yml");
export const llmConfigPath = path.join(dataDir, "llm.yml");
export const projectMcpConfigPath = path.join(repoRoot, ".mcp.json");

let pnpmCommand = null;

export function log(message) {
  process.stdout.write(`[embed-agent] ${message}\n`);
}

export function warn(message) {
  process.stderr.write(`[embed-agent] ${message}\n`);
}

export async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback) {
  if (!(await exists(filePath))) return fallback;
  return JSON.parse(await readFile(filePath, "utf-8"));
}

export async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function ensureTextFile(filePath, content) {
  if (await exists(filePath)) return false;
  await writeFile(filePath, content, "utf-8");
  return true;
}

export async function isServerRunning(url = serverUrl) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runCommand(command, args, options = {}) {
  const { cwd = repoRoot, env = process.env, stdio = "inherit", allowFailure = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve(code ?? 0);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
    });
  });
}

async function canRun(command, args) {
  try {
    const code = await runCommand(command, args, { stdio: "ignore", allowFailure: true });
    return code === 0;
  } catch {
    return false;
  }
}

export async function resolvePnpm() {
  if (pnpmCommand) return pnpmCommand;
  if (await canRun("pnpm", ["--version"])) {
    pnpmCommand = { command: "pnpm", prefix: [] };
    return pnpmCommand;
  }
  if (await canRun("corepack", ["pnpm", "--version"])) {
    pnpmCommand = { command: "corepack", prefix: ["pnpm"] };
    return pnpmCommand;
  }
  throw new Error("pnpm is not available. Install pnpm or enable Corepack first.");
}

export async function runPnpm(args, options = {}) {
  const pnpm = await resolvePnpm();
  return runCommand(pnpm.command, [...pnpm.prefix, ...args], options);
}

export async function ensureDefaultConfig() {
  await ensureDir(dataDir);

  const systemCreated = await ensureTextFile(systemConfigPath, [
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
    `  data_root: ${JSON.stringify(dataDir)}`,
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

  const llmCreated = await ensureTextFile(llmConfigPath, [
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

  if (systemCreated) log(`Created default config: ${path.relative(repoRoot, systemConfigPath)}`);
  if (llmCreated) log(`Created default config: ${path.relative(repoRoot, llmConfigPath)}`);
}

export async function ensureProjectMcpConfig() {
  const config = await readJson(projectMcpConfigPath, { mcpServers: {} });
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};

  servers["embed-agent"] = {
    type: "stdio",
    command: "node",
    args: ["apps/mcp-server/dist/main.js"],
    env: {
      EMBED_AGENT_DATA: ".embed-agent",
      EMBED_AGENT_SERVER_URL: serverUrl,
      EMBED_AGENT_WEB_DIST: "apps/webui/dist",
    },
  };

  config.mcpServers = servers;
  await writeJson(projectMcpConfigPath, config);
  log("Updated project MCP config for Claude Code");
}

export async function verifyClaudeMcp() {
  if (!(await canRun("claude", ["--version"]))) {
    warn("Claude CLI not found. Project MCP config was still written to .mcp.json.");
    return;
  }

  try {
    await runCommand("claude", ["mcp", "get", "embed-agent"], { cwd: repoRoot });
    log("Claude Code MCP entry is ready");
  } catch (error) {
    warn(`Unable to verify Claude Code MCP entry automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function ensureDependenciesInstalled() {
  if (await exists(path.join(repoRoot, "node_modules", ".pnpm"))) return;
  log("Installing workspace dependencies");
  await runPnpm(["install", "--frozen-lockfile"]);
}

export async function ensureBuildArtifacts() {
  log("Building workspace");
  await runPnpm(["build"]);
}

export async function openBrowser(url = webUrl) {
  if (process.platform === "darwin") {
    await runCommand("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    await runCommand("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    return;
  }
  await runCommand("xdg-open", [url], { stdio: "ignore" });
}

export async function startServer() {
  if (await isServerRunning(serverUrl)) return false;

  await ensureDir(logDir);
  const logFd = openSync(serverLogFile, "a");
  const env = {
    ...process.env,
    EMBED_AGENT_DATA: dataDir,
    EMBED_AGENT_SERVER_URL: serverUrl,
    EMBED_AGENT_WEB_DIST: webDistDir,
    HOST: new URL(serverUrl).hostname,
    PORT: String(new URL(serverUrl).port || "8787"),
  };
  const child = spawn(process.execPath, [httpServerEntry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isServerRunning(serverUrl)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Runtime server failed to start. Check ${serverLogFile}`);
}
