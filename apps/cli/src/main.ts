// CLI entry point — creates the full app and dispatches commands.
// This file is intentionally thin; wiring of RunManager, Views, and stores
// is done by the embed-agent application launcher.
import { runCli } from "./cli.js";

// The handler is injected — in production this is wired by the application
// bootstrap that creates all stores, tools, runtime, and agent instances.
// For now, export runCli for programmatic use.
runCli(null as never).catch(() => process.exit(1));
