import {
  EvidenceKindSchema,
  EvidenceRefSchema,
  KeyEventSchema,
  KeyEvidenceSchema,
  PublicErrorCodeSchema,
  RunStateSchema
} from "@artifact-validation/contracts";
import { z } from "zod";

const ValidateArtifactMcpStatusSchema = z.enum([
  "accepted",
  "busy",
  "artifact_invalid",
  "clarification_needed",
  "plan_rejected",
  "target_not_found",
  "error"
]);

const RunResultMcpStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "collecting_evidence",
  "completed",
  "failed",
  "paused",
  "cancelled",
  "timeout"
]);

// MCP SDK 1.29 only preserves and validates output schemas that normalize to
// object schemas. Our shared Runtime contracts use unions for several tools, so
// the MCP adapter exposes equivalent object-root schemas here.
export const ValidateArtifactMcpOutputSchema = z
  .object({
    status: ValidateArtifactMcpStatusSchema,
    run_id: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    state: RunStateSchema.optional(),
    estimated_duration_sec: z.number().int().positive().optional(),
    evidence_path: z.string().min(1).optional(),
    reasons: z.array(z.string().min(1)).optional(),
    missing_info: z.array(z.string().min(1)).optional(),
    suggested_next: z.string().min(1).optional(),
    error_code: PublicErrorCodeSchema.optional(),
    message: z.string().min(1).optional()
  })
  .catchall(z.unknown());

export const GetEvidenceMcpOutputSchema = z
  .object({
    run_id: z.string().min(1).optional(),
    partial: z.boolean().optional(),
    updated_at: z.string().min(1).optional(),
    root_path: z.string().min(1).optional(),
    refs: z.array(EvidenceRefSchema).optional(),
    key_events: z.array(KeyEventSchema).optional(),
    ref: z.string().min(1).optional(),
    kind: EvidenceKindSchema.optional(),
    path: z.string().min(1).optional(),
    available: z.boolean().optional(),
    bytes: z.number().int().nonnegative().optional(),
    source_ref: z.string().min(1).optional()
  })
  .catchall(z.unknown());

export const GetRunResultMcpOutputSchema = z
  .object({
    run_id: z.string().min(1),
    status: RunResultMcpStatusSchema,
    result_available: z.boolean().optional(),
    summary: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    key_evidence: z.array(KeyEvidenceSchema).optional(),
    suggested_next: z.string().min(1).optional(),
    evidence_path: z.string().min(1).optional(),
    report_path: z.string().min(1).optional()
  })
  .catchall(z.unknown());
