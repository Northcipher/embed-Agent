import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptDir, "..");
const installRoot = path.resolve(runtimeRoot, "..", "..");
const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
const defaultDataDir = path.join(localAppData, "EmbedAgent", "data");

process.env["EMBED_AGENT_HOME"] ??= installRoot;
process.env["EMBED_AGENT_RUNTIME_ROOT"] ??= runtimeRoot;
process.env["EMBED_AGENT_SERVER_ENTRY"] ??= path.join(runtimeRoot, "server", "dist", "main.js");
process.env["EMBED_AGENT_WEB_DIST"] ??= path.join(runtimeRoot, "webui");
process.env["EMBED_AGENT_DATA"] ??= defaultDataDir;
process.env["EMBED_AGENT_SERVER_URL"] ??= "http://127.0.0.1:8787";

const mode = process.argv[2];
const passthroughArgs = process.argv.slice(3);

async function runCli() {
  const entry = path.join(runtimeRoot, "server", "node_modules", "@embed-agent", "cli", "dist", "main.js");
  process.argv = [process.execPath, entry, ...passthroughArgs];
  await import(pathToFileURL(entry).href);
}

async function runMcp() {
  const entry = path.join(runtimeRoot, "mcp", "dist", "main.js");
  process.argv = [process.execPath, entry, ...passthroughArgs];
  await import(pathToFileURL(entry).href);
}

switch (mode) {
  case "cli":
    await runCli();
    break;
  case "mcp":
    await runMcp();
    break;
  default:
    process.stderr.write(`Unknown launcher mode: ${mode ?? "<missing>"}\n`);
    process.exit(1);
}
