import { log, openBrowser, serverLogFile, startServer, webUrl } from "./desktop-lib.mjs";

export async function runLaunch() {
  const started = await startServer();
  await openBrowser(webUrl);
  log(started ? `Embed Agent started at ${webUrl}` : `Embed Agent is already running at ${webUrl}`);
  log(`Server log: ${serverLogFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLaunch().catch((error) => {
    process.stderr.write(`[embed-agent] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
