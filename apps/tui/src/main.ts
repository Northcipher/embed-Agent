import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, Logger } from "@embed-agent/stores";
import { Views } from "@embed-agent/views";
import { startTui } from "./app.js";

const dataRoot = process.env["EMBED_AGENT_DATA"] ?? ".embed-agent";
const log = new Logger({ module: "tui" });

const runStore = new RunStore(dataRoot, log);
const targetStore = new TargetStore(dataRoot);
const memoryStore = new MemoryStore(dataRoot);
const eventStore = new EventStore(dataRoot);
const evidenceStore = new EvidenceStore(dataRoot);

const views = new Views(runStore, eventStore, evidenceStore, targetStore, memoryStore);

startTui(views);
