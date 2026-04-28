import { z } from "zod";

export const EvidenceKindSchema = z.enum(["log", "window", "snapshot", "report", "command_output", "metadata"]);

export const EvidenceRefSchema = z
  .object({
    ref: z.string().min(1),
    kind: EvidenceKindSchema,
    path: z.string().min(1),
    available: z.boolean(),
    bytes: z.number().int().nonnegative().optional(),
    source_ref: z.string().min(1).optional()
  })
  .strict();

export const KeyEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    summary: z.string().min(1),
    evidence_refs: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const KeyEvidenceSchema = z
  .object({
    summary: z.string().min(1),
    evidence_refs: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const EvidenceIndexSchema = z
  .object({
    run_id: z.string().min(1),
    partial: z.boolean(),
    updated_at: z.string().min(1),
    root_path: z.string().min(1),
    refs: z.array(EvidenceRefSchema),
    key_events: z.array(KeyEventSchema)
  })
  .strict();

export const AgentReplyStatusSchema = z.enum(["completed", "failed", "timeout", "cancelled"]);

export const AgentReplySchema = z
  .object({
    run_id: z.string().min(1),
    status: AgentReplyStatusSchema,
    summary: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
    key_evidence: z.array(KeyEvidenceSchema),
    suggested_next: z.string().min(1).optional(),
    evidence_path: z.string().min(1),
    report_path: z.string().min(1).optional()
  })
  .strict();

export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type KeyEvent = z.infer<typeof KeyEventSchema>;
export type KeyEvidence = z.infer<typeof KeyEvidenceSchema>;
export type EvidenceIndex = z.infer<typeof EvidenceIndexSchema>;
export type AgentReplyStatus = z.infer<typeof AgentReplyStatusSchema>;
export type AgentReply = z.infer<typeof AgentReplySchema>;
