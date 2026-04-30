// MCP Server stdio entry — boots with query-only Views support
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore, Logger } from "@embed-agent/stores";
import { Views } from "@embed-agent/views";
import { createMcpServer } from "./server.js";

const dataRoot = process.env["EMBED_AGENT_DATA"] ?? ".embed-agent";
const log = new Logger({ module: "mcp-server" });

const runStore = new RunStore(dataRoot, log);
const targetStore = new TargetStore(dataRoot);
const memoryStore = new MemoryStore(dataRoot);
const eventStore = new EventStore(dataRoot);
const evidenceStore = new EvidenceStore(dataRoot);
const views = new Views(runStore, eventStore, evidenceStore, targetStore, memoryStore);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers: Record<string, (input: any) => Promise<any>> = {
  validate_artifact: async () => ({
    status: "clarification_needed",
    missing_info: ["RunManager not available in MCP server — use CLI for validate"],
    suggested_next: "Use embedagent CLI with full bootstrap for validation",
  }),
  get_run_status: async (input) => {
    const s = await views.status(input.run_id);
    if (!s) return null;
    return { run_id: s.run_id, state: s.state, elapsed_sec: s.elapsed_sec, evidence_path: s.evidence_path, last_event_seq: 0 };
  },
  watch_run: async (input) => {
    const s = await views.events(input.run_id, input.after_seq, input.limit ?? 100);
    const run = await runStore.get(input.run_id);
    return { run_id: input.run_id, status: run?.state ?? "unknown", events: s.events, next_after_seq: s.next_after_seq };
  },
  get_run_events: async (input) => views.events(input.run_id, input.after_seq, input.limit, input.types),
  get_evidence: async (input) => views.evidence(input.run_id, input.ref),
  get_run_result: async (input) => views.result(input.run_id),
  intervene_run: async (input) => ({ run_id: input.run_id, accepted: false, action: input.action, event_seq: undefined }),
  cancel_run: async (input) => ({ run_id: input.run_id, accepted: false, status: "error" }),
  get_target_capabilities: async (input) => {
    const t = await views.targets();
    const found = t.find(x => x.target_id === input.target);
    if (!found) return { target: input.target, runtime_state: { state: "unknown", serial: "unknown", adb: "unknown", fastboot: "unknown" }, capabilities: [] };
    const caps: string[] = [];
    if (found.serial === "connected") caps.push("serial_output");
    if (found.adb === "online") caps.push("shell_exec", "wait_adb", "collect_logs");
    if (found.fastboot === "connected") caps.push("flash");
    return { target: input.target, runtime_state: { state: found.state, serial: found.serial, adb: found.adb, fastboot: found.fastboot, current_run_id: found.current_run_id }, capabilities: caps };
  },
};

// Simple stdio transport
const transport = {
  onmessage: (() => {}) as (msg: { method: string; params?: { name: string; arguments?: Record<string, unknown> }; id?: unknown }) => void,
  async start() {
    process.stdin.setEncoding("utf-8");
    let buf = "";
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.jsonrpc && this.onmessage) this.onmessage(msg);
        } catch { /* skip malformed */ }
      }
    });
    log.info("MCP Server started on stdio");
  },
  async send(msg: { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } }) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  },
};
createMcpServer(handlers as never, transport);
transport.start();
