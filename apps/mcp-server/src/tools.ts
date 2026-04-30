import { z } from "zod";

// --- Input Schemas ---

export const ValidateArtifactInput = z.object({
  target: z.string(),
  artifact_path: z.string(),
  artifact_type: z.string(),
  expected: z.string(),
  success_criteria: z.array(z.string()).optional(),
  failure_criteria: z.array(z.string()).optional(),
  max_duration_sec: z.number().optional(),
  allow_flash: z.boolean().optional(),
  allow_shell_exec: z.boolean().optional(),
  no_flash: z.boolean().optional(),
  continuous: z.boolean().optional(),
  test_hint: z.object({ kind: z.enum(["serial","adb_shell","fastboot","custom"]), command: z.string().optional(), pattern: z.string().optional() }).optional(),
  concerns: z.array(z.string()).optional(),
});

export const GetRunStatusInput = z.object({ run_id: z.string() });

export const WatchRunInput = z.object({
  run_id: z.string(),
  after_seq: z.number().optional(),
  limit: z.number().optional(),
  wait_sec: z.number().optional(),
});

export const GetRunEventsInput = z.object({
  run_id: z.string(),
  after_seq: z.number().optional(),
  limit: z.number().optional(),
  types: z.array(z.string()).optional(),
});

export const GetEvidenceInput = z.object({
  run_id: z.string(),
  ref: z.string().optional(),
});

export const GetRunResultInput = z.object({ run_id: z.string() });

export const InterveneRunInput = z.object({
  run_id: z.string(),
  action: z.enum(["pause", "resume", "cancel", "add_instruction", "ignore_rule", "override"]),
  reason: z.string(),
  instruction: z.string().optional(),
  rule_id: z.string().optional(),
  decision: z.enum(["continue", "stop", "cancel"]).optional(),
});

export const CancelRunInput = z.object({
  run_id: z.string(),
  reason: z.string().optional(),
});

export const GetTargetCapabilitiesInput = z.object({ target: z.string() });

// --- Response type: every tool returns this shape ---

export interface ToolResponse<T = Record<string, unknown>> {
  summary: string;
  data: T;
}

// --- Tool definitions (for MCP server registration) ---

export const TOOL_DEFINITIONS = [
  {
    name: "list_targets",
    description: "List all configured targets with state, capabilities, connections, and active runs. Start here when you need to discover available devices.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_target_capabilities",
    description: "Get the capabilities, connection state, and runtime info for a specific target device.",
    inputSchema: {
      type: "object" as const,
      properties: { target: { type: "string", description: "Target device ID (e.g. 'esp32', 'demo')" } },
      required: ["target"],
    },
  },
  {
    name: "validate_artifact",
    description: "Start a validation run on a target device. Only 4 fields are required: target, artifact_path, artifact_type, expected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "Target device ID to validate on" },
        artifact_path: { type: "string", description: "Path to firmware/artifact file" },
        artifact_type: { type: "string", description: "Type: firmware, apk, binary, config, other" },
        expected: { type: "string", description: "What should happen (e.g. 'Device boots to login prompt')" },
        success_criteria: { type: "array", items: { type: "string" }, description: "Explicit pass conditions" },
        failure_criteria: { type: "array", items: { type: "string" }, description: "Known failure signals to watch for" },
        max_duration_sec: { type: "number", description: "Max run duration in seconds" },
        allow_flash: { type: "boolean", description: "Allow flashing the device" },
        allow_shell_exec: { type: "boolean", description: "Allow shell commands on device" },
        no_flash: { type: "boolean", description: "Skip flashing even if plan requires it" },
        continuous: { type: "boolean", description: "Run continuously without auto-stopping" },
        test_hint: { type: "object", properties: { kind: { type: "string", enum: ["serial","adb_shell","fastboot","custom"] }, command: { type: "string" }, pattern: { type: "string" } }, description: "Structured test hint: {kind, command?, pattern?}" },
        concerns: { type: "array", items: { type: "string" }, description: "Specific concerns to watch for" },
      },
      required: ["target", "artifact_path", "artifact_type", "expected"],
    },
  },
  {
    name: "get_run_status",
    description: "Get the current state, progress, and recent decisions for a validation run.",
    inputSchema: {
      type: "object" as const,
      properties: { run_id: { type: "string", description: "Run ID" } },
      required: ["run_id"],
    },
  },
  {
    name: "watch_run",
    description: "Watch a run for new events. Blocks up to wait_sec (max 30s) until new events arrive, then returns. Always includes the current run state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        after_seq: { type: "number", description: "Only return events after this sequence number" },
        limit: { type: "number", description: "Max events to return (default 100)" },
        wait_sec: { type: "number", description: "How long to wait for new events (max 30s, default 5s)" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_run_events",
    description: "Get paginated events from a run. Always includes the current run state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        after_seq: { type: "number" },
        limit: { type: "number" },
        types: { type: "array", items: { type: "string" }, description: "Filter by event types" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_evidence",
    description: "Get evidence from a run. Without ref: returns the full evidence index. With ref: returns specific evidence content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        ref: { type: "string", description: "Specific evidence ref (e.g. serial:last-window). Omit for index." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_run_result",
    description: "Get the final verdict and evidence for a completed run. Returns verdict (pass/fail/blocked/inconclusive/cancelled), checks with evidence refs, and suggested next steps.",
    inputSchema: {
      type: "object" as const,
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "intervene_run",
    description: "Intervene in a running validation. Reason is required for audit trail. Returns success/failure with explanation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        action: { type: "string", enum: ["pause", "resume", "cancel", "add_instruction", "ignore_rule", "override"] },
        reason: { type: "string", description: "Why this intervention is needed (required for audit)" },
        instruction: { type: "string", description: "Instruction text for add_instruction action" },
        rule_id: { type: "string", description: "Rule ID for ignore_rule action" },
        decision: { type: "string", enum: ["continue", "stop", "cancel"], description: "Decision for override action" },
      },
      required: ["run_id", "action", "reason"],
    },
  },
  {
    name: "cancel_run",
    description: "Cancel a running validation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        reason: { type: "string", description: "Why the run is being cancelled" },
      },
      required: ["run_id"],
    },
  },
];

// --- Tool handler types ---

export interface ToolHandlers {
  list_targets(): Promise<ToolResponse<{
    targets: { target_id: string; state: string; capabilities: string[]; connections: { serial: string; adb: string; fastboot: string }; current_run_id?: string }[];
  }>>;
  get_target_capabilities(input: z.infer<typeof GetTargetCapabilitiesInput>): Promise<ToolResponse<{
    target: string; state: string; capabilities: string[]; connections: { serial: string; adb: string; fastboot: string }; current_run_id?: string;
  }>>;
  validate_artifact(input: z.infer<typeof ValidateArtifactInput>): Promise<ToolResponse<{
    status: string; run_id?: string; state?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[]; missing_info?: string[]; suggested_next?: string;
  }>>;
  get_run_status(input: z.infer<typeof GetRunStatusInput>): Promise<ToolResponse<{
    run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; last_event_seq: number; evidence_path: string;
  }>>;
  watch_run(input: z.infer<typeof WatchRunInput>): Promise<ToolResponse<{
    run_id: string; state: string; events: { seq: number; type: string; severity?: string; summary: string; time: string }[]; next_after_seq: number;
  }>>;
  get_run_events(input: z.infer<typeof GetRunEventsInput>): Promise<ToolResponse<{
    run_id: string; state: string; events: { seq: number; type: string; severity?: string; summary: string; time: string }[]; next_after_seq: number; has_more: boolean;
  }>>;
  get_evidence(input: z.infer<typeof GetEvidenceInput>): Promise<ToolResponse<{
    index?: { refs: { ref: string; kind: string; bytes?: number; summary?: string }[]; key_events: { seq: number; summary: string }[] };
    content?: string; ref?: string; truncated?: boolean;
    available: boolean;
  }>>;
  get_run_result(input: z.infer<typeof GetRunResultInput>): Promise<ToolResponse<{
    run_id: string; verdict: "pass" | "fail" | "blocked" | "inconclusive" | "cancelled";
    state: string;
    confidence: number; summary: string;
    checks: { id: string; title: string; status: "pass" | "fail" | "skipped"; reason: string; evidence_refs: string[] }[];
    key_evidence: { summary: string; evidence_refs: string[] }[];
    suggested_next: string;
    result_available: boolean;
  }>>;
  intervene_run(input: z.infer<typeof InterveneRunInput>): Promise<ToolResponse<{
    run_id: string; accepted: boolean; action: string; reason?: string;
  }>>;
  cancel_run(input: z.infer<typeof CancelRunInput>): Promise<ToolResponse<{
    run_id: string; accepted: boolean; status: string;
  }>>;
}
