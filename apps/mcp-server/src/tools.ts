import { z } from "zod";

// --- Input Schemas ---

export const ValidateArtifactInput = z.object({
  context: z.object({
    task: z.string(),
    expected: z.string(),
    concerns: z.array(z.string()).optional(),
    what_changed: z.string().optional(),
    test_hint: z.object({
      kind: z.literal("adb_shell"),
      command: z.string(),
      timeout_sec: z.number().optional(),
      expected_exit_code: z.number().optional(),
    }).optional(),
  }),
  artifact: z.object({
    path: z.string(),
    type: z.string(),
    version: z.string().optional(),
    build_id: z.string().optional(),
  }),
  target: z.string(),
  constraints: z.object({
    max_duration_sec: z.number().optional(),
    allow_flash: z.boolean().optional(),
    allow_shell_exec: z.boolean().optional(),
    no_flash: z.boolean().optional(),
    continuous: z.boolean().optional(),
    observe_interval: z.number().optional(),
    observe_metrics: z.array(z.string()).optional(),
  }).optional(),
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
  instruction: z.string().optional(),
  rule_id: z.string().optional(),
  decision: z.enum(["continue", "stop", "cancel"]).optional(),
  reason: z.string().optional(),
});

export const CancelRunInput = z.object({
  run_id: z.string(),
  reason: z.string().optional(),
});

export const GetTargetCapabilitiesInput = z.object({ target: z.string() });

// --- Tool definitions (for MCP server registration) ---

export const TOOL_DEFINITIONS = [
  {
    name: "validate_artifact",
    description: "Validate an artifact on a target device. Creates a new validation run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        context: {
          type: "object",
          properties: {
            task: { type: "string", description: "What to validate" },
            expected: { type: "string", description: "Expected outcome" },
            concerns: { type: "array", items: { type: "string" }, description: "Risk concerns" },
            what_changed: { type: "string", description: "What changed from last version" },
            test_hint: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["adb_shell"] },
                command: { type: "string" },
                timeout_sec: { type: "number" },
                expected_exit_code: { type: "number" },
              },
            },
          },
          required: ["task", "expected"],
        },
        artifact: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to artifact file" },
            type: { type: "string", description: "Artifact type (firmware, apk, etc.)" },
            version: { type: "string" },
            build_id: { type: "string" },
          },
          required: ["path", "type"],
        },
        target: { type: "string", description: "Target device ID" },
        constraints: {
          type: "object",
          properties: {
            max_duration_sec: { type: "number" },
            allow_flash: { type: "boolean" },
            no_flash: { type: "boolean" },
            continuous: { type: "boolean" },
          },
        },
      },
      required: ["context", "artifact", "target"],
    },
  },
  {
    name: "get_run_status",
    description: "Get the current status of a validation run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string", description: "Run ID" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "watch_run",
    description: "Watch a run for real-time events.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        after_seq: { type: "number", description: "Only return events after this sequence number" },
        limit: { type: "number", description: "Max events to return" },
        wait_sec: { type: "number", description: "How long to wait for new events" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_run_events",
    description: "Get paginated events from a run.",
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
    description: "Get evidence from a run — either the full index or a specific evidence ref.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        ref: { type: "string", description: "Specific evidence ref (e.g. serial:last-window)" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_run_result",
    description: "Get the final result of a completed run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "intervene_run",
    description: "Intervene in a running validation — pause, resume, cancel, add instruction, ignore rule, or override decision.",
    inputSchema: {
      type: "object" as const,
      properties: {
        run_id: { type: "string" },
        action: { type: "string", enum: ["pause", "resume", "cancel", "add_instruction", "ignore_rule", "override"] },
        instruction: { type: "string", description: "Instruction text for add_instruction action" },
        rule_id: { type: "string", description: "Rule ID for ignore_rule action" },
        decision: { type: "string", enum: ["continue", "stop", "cancel"], description: "Decision for override action" },
        reason: { type: "string", description: "Reason for the intervention" },
      },
      required: ["run_id", "action"],
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
  {
    name: "get_target_capabilities",
    description: "Get the capabilities and runtime state of a target device.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: { type: "string", description: "Target device ID" },
      },
      required: ["target"],
    },
  },
];

// --- Tool handler types ---

export interface ToolHandlers {
  validate_artifact(input: z.infer<typeof ValidateArtifactInput>): Promise<{
    status: string; run_id?: string; reasons?: string[]; failed_checks?: { check: string; error: string }[];
  }>;
  get_run_status(input: z.infer<typeof GetRunStatusInput>): Promise<{
    run_id: string; state: string; current_step?: { id: string }; elapsed_sec: number; evidence_path?: string;
  } | null>;
  watch_run(input: z.infer<typeof WatchRunInput>): Promise<{
    run_id: string; events: { seq: number; type: string; severity?: string; summary: string; time: string }[]; next_after_seq: number;
  }>;
  get_run_events(input: z.infer<typeof GetRunEventsInput>): Promise<{
    run_id: string; events: { seq: number; type: string; severity?: string; summary: string; time: string }[]; next_after_seq: number; has_more: boolean;
  }>;
  get_evidence(input: z.infer<typeof GetEvidenceInput>): Promise<{
    available: boolean; index?: { refs: { ref: string; kind: string }[] }; content?: string;
  }>;
  get_run_result(input: z.infer<typeof GetRunResultInput>): Promise<{
    run_id: string; state: string; result_available: boolean; summary?: string; suggested_next?: string; evidence_path?: string;
    key_evidence?: { summary: string; evidence_refs: string[] }[];
  }>;
  intervene_run(input: z.infer<typeof InterveneRunInput>): Promise<{
    run_id: string; accepted: boolean; action: string;
  }>;
  cancel_run(input: z.infer<typeof CancelRunInput>): Promise<{
    run_id: string; accepted: boolean; status: string;
  }>;
  get_target_capabilities(input: z.infer<typeof GetTargetCapabilitiesInput>): Promise<{
    target: string; state: string; current_run_id?: string;
  }>;
}
