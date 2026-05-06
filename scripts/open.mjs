import { runLaunch } from "./launch.mjs";
import { runSetup } from "./setup.mjs";

async function main() {
  await runSetup();
  await runLaunch();
}

main().catch((error) => {
  process.stderr.write(`[embed-agent] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
