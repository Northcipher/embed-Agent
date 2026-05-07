import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const runtimeRoot = path.join(desktopRoot, "desktop-runtime");
const stagingRoot = path.join(desktopRoot, ".runtime-staging");
const nodeDir = path.join(runtimeRoot, "bin");
const runtimeLibDir = path.join(runtimeRoot, "lib");
const tauriReleaseDir = path.join(desktopRoot, "src-tauri/target/release");
const webuiDistSrc = path.join(repoRoot, "apps/webui/dist");
const promptsSrc = path.join(repoRoot, "config/prompts");
const templateRoot = path.join(desktopRoot, "templates/runtime");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
    });
  });
}

async function resolvePnpmCommand() {
  try {
    await run("pnpm", ["--version"]);
    return { command: "pnpm", prefix: [] };
  } catch {
    await run("corepack", ["pnpm", "--version"]);
    return { command: "corepack", prefix: ["pnpm"] };
  }
}

async function runPnpm(args) {
  const pnpm = await resolvePnpmCommand();
  await run(pnpm.command, [...pnpm.prefix, ...args]);
}

async function ensureBuiltArtifacts() {
  await runPnpm(["--filter", "@embed-agent/cli", "build"]);
  await runPnpm(["--filter", "@embed-agent/mcp-server", "build"]);
  await runPnpm(["--filter", "@embed-agent/http-server", "build"]);
  await runPnpm(["--filter", "@embed-agent/webui", "build"]);
}

async function resolveNodeBinary() {
  const targetTriple = process.env["TAURI_ENV_TARGET_TRIPLE"]
    ?? process.env["CARGO_BUILD_TARGET"]
    ?? inferTargetTriple();
  const extension = targetTriple.includes("windows") ? ".exe" : "";
  const binaryName = `embed-agent-node-${targetTriple}${extension}`;
  return { source: process.execPath, target: path.join(nodeDir, binaryName) };
}

function inferTargetTriple() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`Unsupported platform for desktop runtime packaging: ${process.platform}/${process.arch}`);
}

async function copyNodeBinary() {
  const { source, target } = await resolveNodeBinary();
  await mkdir(nodeDir, { recursive: true });
  await copyFile(source, target);
  await mkdir(tauriReleaseDir, { recursive: true });
  await copyFile(source, path.join(tauriReleaseDir, "embed-agent-node"));
  if (process.platform !== "win32") {
    await chmod(target, 0o755);
    await chmod(path.join(tauriReleaseDir, "embed-agent-node"), 0o755);
  }
  return {
    runtimeBinaryPath: target,
    tauriBinaryPath: path.join(tauriReleaseDir, "embed-agent-node"),
  };
}

function listMachODependencies(targetPath) {
  if (process.platform !== "darwin") {
    return [];
  }

  const raw = execFileSync("otool", ["-L", targetPath], { encoding: "utf8" });
  return raw
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

function listMachORpaths(targetPath) {
  if (process.platform !== "darwin") {
    return [];
  }

  const raw = execFileSync("otool", ["-l", targetPath], { encoding: "utf8" });
  const lines = raw.split("\n");
  const rpaths = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes("cmd LC_RPATH")) {
      continue;
    }

    const pathLine = lines[index + 2]?.trim();
    const match = pathLine?.match(/^path\s+(.+?)\s+\(offset \d+\)$/);
    if (match?.[1]) {
      rpaths.push(match[1]);
    }
  }

  return rpaths;
}

function resolvePathToken(targetPath, token) {
  const loaderDir = path.dirname(targetPath);
  if (token.startsWith("@loader_path/")) {
    return path.resolve(loaderDir, token.slice("@loader_path/".length));
  }
  if (token === "@loader_path") {
    return loaderDir;
  }
  if (token.startsWith("@executable_path/")) {
    return path.resolve(loaderDir, token.slice("@executable_path/".length));
  }
  if (token === "@executable_path") {
    return loaderDir;
  }
  return token;
}

function resolveMachODependency(targetPath, dependency) {
  if (dependency.startsWith("/opt/homebrew/") || dependency.startsWith("/usr/local/")) {
    return dependency;
  }

  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice("@rpath/".length);
    for (const rpath of listMachORpaths(targetPath)) {
      const candidate = path.resolve(resolvePathToken(targetPath, rpath), suffix);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  if (dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/")) {
    const candidate = resolvePathToken(targetPath, dependency);
    return existsSync(candidate) ? candidate : null;
  }

  return null;
}

function listNodeDynamicLibraries(nodeBinaryPath) {
  if (process.platform !== "darwin") {
    return [];
  }

  const libraries = new Set(
    listMachODependencies(nodeBinaryPath)
      .map((dependency) => resolveMachODependency(nodeBinaryPath, dependency))
      .filter(Boolean),
  );
  const queue = [...libraries];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !existsSync(current)) {
      continue;
    }

    for (const dependency of listMachODependencies(current)) {
      const resolvedDependency = resolveMachODependency(current, dependency);
      if (!resolvedDependency || libraries.has(resolvedDependency)) {
        continue;
      }
      libraries.add(resolvedDependency);
      queue.push(resolvedDependency);
    }
  }

  const requiredExtras = [
    "/opt/homebrew/opt/brotli/lib/libbrotlicommon.1.dylib",
    "/opt/homebrew/opt/icu4c@78/lib/libicudata.78.dylib",
  ];
  for (const extra of requiredExtras) {
    if (existsSync(extra)) {
      libraries.add(extra);
    }
  }

  return [...libraries];
}

function rewriteNodeBinaryReferences(nodeBinaryPath, libraryFilenames) {
  if (process.platform !== "darwin") {
    return;
  }

  execFileSync("install_name_tool", [
    "-add_rpath",
    "@loader_path/../Resources/desktop-runtime/lib",
    nodeBinaryPath,
  ]);
  execFileSync("install_name_tool", [
    "-add_rpath",
    "@loader_path/../../../desktop-runtime/lib",
    nodeBinaryPath,
  ]);

  const dependencies = execFileSync("otool", ["-L", nodeBinaryPath], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);

  for (const dependency of dependencies) {
    const basename = path.basename(dependency);
    if (!libraryFilenames.has(basename)) {
      continue;
    }

    execFileSync("install_name_tool", [
      "-change",
      dependency,
      `@rpath/${basename}`,
      nodeBinaryPath,
    ]);
  }
}

function rewriteCopiedLibraryReferences(runtimeLibraries) {
  if (process.platform !== "darwin") {
    return;
  }

  const libraryFilenames = new Set(runtimeLibraries.map((libraryPath) => path.basename(libraryPath)));
  for (const libraryPath of runtimeLibraries) {
    const basename = path.basename(libraryPath);
    execFileSync("install_name_tool", [
      "-id",
      `@loader_path/${basename}`,
      libraryPath,
    ]);

    const dependencies = execFileSync("otool", ["-L", libraryPath], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" ")[0])
      .filter(Boolean);

    for (const dependency of dependencies) {
      const dependencyBasename = path.basename(dependency);
      if (!libraryFilenames.has(dependencyBasename) || dependencyBasename === basename) {
        continue;
      }

      execFileSync("install_name_tool", [
        "-change",
        dependency,
        `@loader_path/${dependencyBasename}`,
        libraryPath,
      ]);
    }
  }
}

function codesignAdhoc(targetPath) {
  if (process.platform !== "darwin") {
    return;
  }

  execFileSync("codesign", ["--force", "--sign", "-", targetPath], {
    stdio: "inherit",
  });
}

async function copyNodeDynamicLibraries() {
  if (process.platform !== "darwin") {
    return [];
  }

  await mkdir(runtimeLibDir, { recursive: true });
  await chmod(runtimeLibDir, 0o755);
  const libraries = listNodeDynamicLibraries(process.execPath);
  const copiedLibraries = [];
  for (const libraryPath of libraries) {
    const targetPath = path.join(runtimeLibDir, path.basename(libraryPath));
    await rm(targetPath, { force: true });
    await copyFile(libraryPath, targetPath);
    await chmod(targetPath, 0o644);
    copiedLibraries.push(targetPath);
  }
  return copiedLibraries;
}

async function materializePortableNodeModules(serverRoot) {
  const nodeModulesRoot = path.join(serverRoot, "node_modules");
  const portableRoot = path.join(nodeModulesRoot, ".pnpm/node_modules");
  if (!(await exists(portableRoot))) {
    return;
  }

  const topLevelEntries = await readdir(portableRoot, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (entry.name === ".bin") {
      continue;
    }

    const sourcePath = path.join(portableRoot, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      const scopedRoot = path.join(nodeModulesRoot, entry.name);
      await mkdir(scopedRoot, { recursive: true });
      const scopedEntries = await readdir(sourcePath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        const scopedSourcePath = path.join(sourcePath, scopedEntry.name);
        const scopedTargetPath = path.join(scopedRoot, scopedEntry.name);
        if (await exists(scopedTargetPath)) {
          continue;
        }
        await cp(scopedSourcePath, scopedTargetPath, { recursive: true, dereference: true });
      }
      continue;
    }

    const targetPath = path.join(nodeModulesRoot, entry.name);
    if (await exists(targetPath)) {
      continue;
    }
    await cp(sourcePath, targetPath, { recursive: true, dereference: true });
  }
}

function getLauncherNodeBinaryName() {
  const targetTriple = process.env["TAURI_ENV_TARGET_TRIPLE"]
    ?? process.env["CARGO_BUILD_TARGET"]
    ?? inferTargetTriple();
  const extension = targetTriple.includes("windows") ? ".exe" : "";
  return `embed-agent-node-${targetTriple}${extension}`;
}

async function writeWindowsLaunchers(integrationRoot) {
  const windowsBinDir = path.join(integrationRoot, "windows", "bin");
  await mkdir(windowsBinDir, { recursive: true });
  const nodeBinaryName = getLauncherNodeBinaryName();

  const cliLauncher = [
    "@echo off",
    "setlocal",
    "set \"SCRIPT_DIR=%~dp0\"",
    "set \"INSTALL_DIR=%SCRIPT_DIR%..\"",
    "set \"NODE_BIN=%INSTALL_DIR%\\" + nodeBinaryName + "\"",
    "if not exist \"%NODE_BIN%\" set \"NODE_BIN=%INSTALL_DIR%\\embed-agent-node.exe\"",
    "if not exist \"%NODE_BIN%\" (",
    "  echo Embed Agent sidecar node binary not found in %INSTALL_DIR%",
    "  exit /b 1",
    ")",
    "\"%NODE_BIN%\" \"%INSTALL_DIR%\\resources\\desktop-runtime\\integrations\\launcher.mjs\" cli %*",
    "",
  ].join("\r\n");

  const mcpLauncher = [
    "@echo off",
    "setlocal",
    "set \"SCRIPT_DIR=%~dp0\"",
    "set \"INSTALL_DIR=%SCRIPT_DIR%..\"",
    "set \"NODE_BIN=%INSTALL_DIR%\\" + nodeBinaryName + "\"",
    "if not exist \"%NODE_BIN%\" set \"NODE_BIN=%INSTALL_DIR%\\embed-agent-node.exe\"",
    "if not exist \"%NODE_BIN%\" (",
    "  echo Embed Agent sidecar node binary not found in %INSTALL_DIR%",
    "  exit /b 1",
    ")",
    "\"%NODE_BIN%\" \"%INSTALL_DIR%\\resources\\desktop-runtime\\integrations\\launcher.mjs\" mcp %*",
    "",
  ].join("\r\n");

  const claudeSetupLauncher = [
    "@echo off",
    "setlocal",
    "set \"SCRIPT_DIR=%~dp0\"",
    "set \"INSTALL_DIR=%SCRIPT_DIR%..\"",
    "\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%INSTALL_DIR%\\resources\\desktop-runtime\\integrations\\setup-claude-code.ps1\" -InstallDir \"%INSTALL_DIR%\" %*",
    "",
  ].join("\r\n");

  await writeFile(path.join(windowsBinDir, "embedagent.cmd"), cliLauncher);
  await writeFile(path.join(windowsBinDir, "embedagent-mcp.cmd"), mcpLauncher);
  await writeFile(path.join(windowsBinDir, "embedagent-claude-setup.cmd"), claudeSetupLauncher);
}

async function copyIntegrationAssets() {
  const integrationRoot = path.join(runtimeRoot, "integrations");
  await cp(templateRoot, integrationRoot, { recursive: true });
  await writeWindowsLaunchers(integrationRoot);
}

async function copyRuntimeTree() {
  await rm(runtimeRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(runtimeLibDir, { recursive: true });
  const copiedNodeBinary = await copyNodeBinary();
  const copiedLibraries = await copyNodeDynamicLibraries();
  rewriteCopiedLibraryReferences(copiedLibraries);
  rewriteNodeBinaryReferences(
    copiedNodeBinary.runtimeBinaryPath,
    new Set(copiedLibraries.map((libraryPath) => path.basename(libraryPath))),
  );
  rewriteNodeBinaryReferences(
    copiedNodeBinary.tauriBinaryPath,
    new Set(copiedLibraries.map((libraryPath) => path.basename(libraryPath))),
  );
  for (const libraryPath of copiedLibraries) {
    codesignAdhoc(libraryPath);
    await chmod(libraryPath, 0o644);
  }
  codesignAdhoc(copiedNodeBinary.runtimeBinaryPath);
  codesignAdhoc(copiedNodeBinary.tauriBinaryPath);
  await chmod(copiedNodeBinary.runtimeBinaryPath, 0o755);
  await chmod(copiedNodeBinary.tauriBinaryPath, 0o755);
  await mkdir(stagingRoot, { recursive: true });
  await runPnpm([
    "config",
    "set",
    "inject-workspace-packages",
    "true",
    "--location",
    "project",
  ]);
  await runPnpm([
    "--filter",
    "@embed-agent/http-server",
    "--prod",
    "deploy",
    path.join(stagingRoot, "server"),
  ]);

  await cp(path.join(stagingRoot, "server"), path.join(runtimeRoot, "server"), {
    recursive: true,
    dereference: true,
  });
  await materializePortableNodeModules(path.join(runtimeRoot, "server"));

  await runPnpm([
    "--filter",
    "@embed-agent/mcp-server",
    "--prod",
    "deploy",
    path.join(stagingRoot, "mcp"),
  ]);

  await cp(path.join(stagingRoot, "mcp"), path.join(runtimeRoot, "mcp"), {
    recursive: true,
    dereference: true,
  });
  await materializePortableNodeModules(path.join(runtimeRoot, "mcp"));

  await cp(webuiDistSrc, path.join(runtimeRoot, "webui"), { recursive: true });
  await cp(promptsSrc, path.join(runtimeRoot, "config/prompts"), { recursive: true });
  await copyIntegrationAssets();
  await rm(stagingRoot, { recursive: true, force: true });
}

async function main() {
  await ensureBuiltArtifacts();
  await copyRuntimeTree();
  process.stdout.write(`[embed-agent] desktop runtime prepared at ${runtimeRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`[embed-agent] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
