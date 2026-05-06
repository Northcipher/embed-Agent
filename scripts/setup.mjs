import {
  ensureBuildArtifacts,
  ensureDefaultConfig,
  ensureDependenciesInstalled,
  ensureProjectMcpConfig,
  log,
  verifyClaudeMcp,
} from "./desktop-lib.mjs";

export async function runSetup() {
  await ensureDependenciesInstalled();
  await ensureBuildArtifacts();
  await ensureDefaultConfig();
  await ensureProjectMcpConfig();
  await verifyClaudeMcp();
  log("Setup complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSetup().catch((error) => {
    process.stderr.write(`[embed-agent] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
