import { z } from "zod";
import { CapabilityNameSchema, CapabilityStatusSchema } from "./capabilities.js";
import { RunEventSchema, EventTypeSchema } from "./events.js";
import { EvidenceIndexSchema, EvidenceRefSchema, AgentReplySchema } from "./evidence.js";
import { PublicErrorResponseSchema, RunStateSchema } from "./primitives.js";

export const TestHintKindSchema = z.enum(["adb_shell", "script_ref", "http_request", "process_check"]);

export const AdbShellTestHintSchema = z
  .object({
    kind: z.literal("adb_shell"),
    command: z.string().min(1),
    timeout_sec: z.number().int().positive().optional(),
    expected_exit_code: z.number().int().optional()
  })
  .strict();

export const FutureTestHintSchema = z
  .object({
    kind: z.enum(["script_ref", "http_request", "process_check"]),
    command: z.string().min(1).optional(),
    timeout_sec: z.number().int().positive().optional(),
    expected_exit_code: z.number().int().optional()
  })
  .strict();

export const TestHintSchema = z.discriminatedUnion("kind", [AdbShellTestHintSchema, FutureTestHintSchema]);

export const ValidationContextSchema = z
  .object({
    task: z.string().min(1),
    what_changed: z.string().min(1).optional(),
    expected: z.string().min(1),
    concerns: z.array(z.string().min(1)).optional(),
    test_hint: TestHintSchema.optional()
  })
  .strict();

export const ArtifactInputSchema = z
  .object({
    path: z.string().min(1),
    type: z.string().min(1),
    sha256: z.string().min(1).optional()
  })
  .strict();

export const ConstraintsSchema = z
  .object({
    max_duration_sec: z.number().int().positive(),
    allow_flash: z.boolean().optional(),
    allow_reboot: z.boolean().optional(),
    allow_shell_exec: z.boolean().optional(),
    allow_power_cycle: z.boolean().optional(),
    allow_kill_process: z.boolean().optional(),
    allow_inject_fault: z.boolean().optional(),
    max_log_bytes: z.number().int().positive().optional()
  })
  .strict();

export const ValidateArtifactInputSchema = z
  .object({
    context: ValidationContextSchema,
    artifact: ArtifactInputSchema,
    target: z.string().min(1),
    constraints: ConstraintsSchema
  })
  .strict();

export const ValidateArtifactAcceptedResponseSchema = z
  .object({
    status: z.literal("accepted"),
    run_id: z.string().min(1),
    target: z.string().min(1),
    state: RunStateSchema,
    estimated_duration_sec: z.number().int().positive().optional(),
    evidence_path: z.string().min(1)
  })
  .strict();

export const ValidateArtifactRejectedStatusSchema = z.enum([
  "busy",
  "artifact_invalid",
  "clarification_needed",
  "plan_rejected",
  "target_not_found"
]);

export const ValidateArtifactRejectedResponseSchema = z
  .object({
    status: ValidateArtifactRejectedStatusSchema,
    run_id: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    reasons: z.array(z.string().min(1)).min(1),
    missing_info: z.array(z.string().min(1)),
    suggested_next: z.string().min(1)
  })
  .strict();

export const ValidateArtifactResponseSchema = z.union([
  ValidateArtifactAcceptedResponseSchema,
  ValidateArtifactRejectedResponseSchema,
  PublicErrorResponseSchema
]);

export const RunStatusInputSchema = z
  .object({
    run_id: z.string().min(1)
  })
  .strict();

export const CurrentStepStatusSchema = z
  .object({
    id: z.string().min(1),
    capability: CapabilityNameSchema,
    started_at: z.string().min(1),
    timeout_sec: z.number().int().positive()
  })
  .strict();

export const TargetStateSchema = z.enum(["idle", "busy", "flashing", "booting", "adb_ready", "offline", "unknown"]);

export const TargetRuntimeStateSchema = z
  .object({
    target_id: z.string().min(1).optional(),
    state: TargetStateSchema,
    serial: z.string().min(1).optional(),
    adb: z.string().min(1).optional(),
    current_run_id: z.string().min(1).nullable().optional(),
    last_heartbeat_at: z.string().min(1).optional(),
    updated_at: z.string().min(1).optional()
  })
  .strict();

export const RunStatusResponseSchema = z
  .object({
    run_id: z.string().min(1),
    status: RunStateSchema,
    phase: z.string().min(1).optional(),
    current_step: CurrentStepStatusSchema.optional(),
    target: TargetRuntimeStateSchema,
    elapsed_sec: z.number().nonnegative(),
    last_event_seq: z.number().int().nonnegative(),
    evidence_path: z.string().min(1)
  })
  .strict();

export const WatchRunInputSchema = z
  .object({
    run_id: z.string().min(1),
    after_seq: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(500).default(50),
    wait_sec: z.number().int().nonnegative().default(0)
  })
  .strict();

export const WatchRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    status: RunStateSchema,
    events: z.array(RunEventSchema),
    next_after_seq: z.number().int().nonnegative()
  })
  .strict();

export const GetRunEventsInputSchema = z
  .object({
    run_id: z.string().min(1),
    after_seq: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(1000).default(100),
    types: z.array(EventTypeSchema).optional()
  })
  .strict();

export const GetRunEventsResponseSchema = z
  .object({
    run_id: z.string().min(1),
    events: z.array(RunEventSchema),
    next_after_seq: z.number().int().nonnegative(),
    has_more: z.boolean()
  })
  .strict();

export const GetEvidenceInputSchema = z
  .object({
    run_id: z.string().min(1),
    ref: z.string().min(1).nullable().optional()
  })
  .strict();

export const GetEvidenceResponseSchema = z.union([EvidenceIndexSchema, EvidenceRefSchema]);

export const GetRunResultInputSchema = z
  .object({
    run_id: z.string().min(1)
  })
  .strict();

export const RunResultUnavailableResponseSchema = z
  .object({
    run_id: z.string().min(1),
    status: RunStateSchema,
    result_available: z.literal(false)
  })
  .strict();

export const GetRunResultResponseSchema = z.union([AgentReplySchema, RunResultUnavailableResponseSchema]);

export const InterventionActionSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "add_instruction",
  "request_partial_evidence"
]);

const InterventionBaseShape = {
  run_id: z.string().min(1),
  reason: z.string().min(1).optional()
};

export const AddInstructionInterventionInputSchema = z
  .object({
    ...InterventionBaseShape,
    action: z.literal("add_instruction"),
    instruction: z.string().min(1)
  })
  .strict();

export const PauseInterventionInputSchema = z
  .object({
    ...InterventionBaseShape,
    action: z.literal("pause")
  })
  .strict();

export const ResumeInterventionInputSchema = z
  .object({
    ...InterventionBaseShape,
    action: z.literal("resume")
  })
  .strict();

export const CancelInterventionInputSchema = z
  .object({
    ...InterventionBaseShape,
    action: z.literal("cancel")
  })
  .strict();

export const RequestPartialEvidenceInterventionInputSchema = z
  .object({
    ...InterventionBaseShape,
    action: z.literal("request_partial_evidence")
  })
  .strict();

export const ControlInterventionInputSchema = z.union([
  PauseInterventionInputSchema,
  ResumeInterventionInputSchema,
  CancelInterventionInputSchema,
  RequestPartialEvidenceInterventionInputSchema
]);

export const InterveneRunInputSchema = z.discriminatedUnion("action", [
  AddInstructionInterventionInputSchema,
  PauseInterventionInputSchema,
  ResumeInterventionInputSchema,
  CancelInterventionInputSchema,
  RequestPartialEvidenceInterventionInputSchema
]);

export const InterveneRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    accepted: z.boolean(),
    action: InterventionActionSchema,
    status: RunStateSchema,
    event_seq: z.number().int().nonnegative().optional(),
    reason: z.string().min(1).optional()
  })
  .strict();

export const CancelRunInputSchema = z
  .object({
    run_id: z.string().min(1),
    reason: z.string().min(1).optional()
  })
  .strict();

export const CancelRunResponseSchema = z
  .object({
    run_id: z.string().min(1),
    status: z.literal("cancelled"),
    evidence_path: z.string().min(1)
  })
  .strict();

export const GetTargetCapabilitiesInputSchema = z
  .object({
    target: z.string().min(1)
  })
  .strict();

export const GetTargetCapabilitiesResponseSchema = z
  .object({
    target: z.string().min(1),
    runtime_state: TargetRuntimeStateSchema,
    capabilities: z.array(CapabilityStatusSchema)
  })
  .strict();

export type TestHintKind = z.infer<typeof TestHintKindSchema>;
export type AdbShellTestHint = z.infer<typeof AdbShellTestHintSchema>;
export type FutureTestHint = z.infer<typeof FutureTestHintSchema>;
export type TestHint = z.infer<typeof TestHintSchema>;
export type ValidationContext = z.infer<typeof ValidationContextSchema>;
export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;
export type Constraints = z.infer<typeof ConstraintsSchema>;
export type ValidateArtifactInput = z.infer<typeof ValidateArtifactInputSchema>;
export type ValidateArtifactAcceptedResponse = z.infer<typeof ValidateArtifactAcceptedResponseSchema>;
export type ValidateArtifactRejectedStatus = z.infer<typeof ValidateArtifactRejectedStatusSchema>;
export type ValidateArtifactRejectedResponse = z.infer<typeof ValidateArtifactRejectedResponseSchema>;
export type ValidateArtifactResponse = z.infer<typeof ValidateArtifactResponseSchema>;
export type RunStatusInput = z.infer<typeof RunStatusInputSchema>;
export type CurrentStepStatus = z.infer<typeof CurrentStepStatusSchema>;
export type TargetState = z.infer<typeof TargetStateSchema>;
export type TargetRuntimeState = z.infer<typeof TargetRuntimeStateSchema>;
export type RunStatusResponse = z.infer<typeof RunStatusResponseSchema>;
export type WatchRunInput = z.infer<typeof WatchRunInputSchema>;
export type WatchRunResponse = z.infer<typeof WatchRunResponseSchema>;
export type GetRunEventsInput = z.infer<typeof GetRunEventsInputSchema>;
export type GetRunEventsResponse = z.infer<typeof GetRunEventsResponseSchema>;
export type GetEvidenceInput = z.infer<typeof GetEvidenceInputSchema>;
export type GetEvidenceResponse = z.infer<typeof GetEvidenceResponseSchema>;
export type GetRunResultInput = z.infer<typeof GetRunResultInputSchema>;
export type RunResultUnavailableResponse = z.infer<typeof RunResultUnavailableResponseSchema>;
export type GetRunResultResponse = z.infer<typeof GetRunResultResponseSchema>;
export type InterventionAction = z.infer<typeof InterventionActionSchema>;
export type AddInstructionInterventionInput = z.infer<typeof AddInstructionInterventionInputSchema>;
export type PauseInterventionInput = z.infer<typeof PauseInterventionInputSchema>;
export type ResumeInterventionInput = z.infer<typeof ResumeInterventionInputSchema>;
export type CancelInterventionInput = z.infer<typeof CancelInterventionInputSchema>;
export type RequestPartialEvidenceInterventionInput = z.infer<typeof RequestPartialEvidenceInterventionInputSchema>;
export type ControlInterventionInput = z.infer<typeof ControlInterventionInputSchema>;
export type InterveneRunInput = z.infer<typeof InterveneRunInputSchema>;
export type InterveneRunResponse = z.infer<typeof InterveneRunResponseSchema>;
export type CancelRunInput = z.infer<typeof CancelRunInputSchema>;
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;
export type GetTargetCapabilitiesInput = z.infer<typeof GetTargetCapabilitiesInputSchema>;
export type GetTargetCapabilitiesResponse = z.infer<typeof GetTargetCapabilitiesResponseSchema>;
