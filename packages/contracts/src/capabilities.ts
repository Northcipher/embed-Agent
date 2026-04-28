import { z } from "zod";

export const CapabilityNameSchema = z.enum([
  "flash",
  "push",
  "watch_serial",
  "wait_adb",
  "shell_exec",
  "check_process",
  "collect_logs",
  "save_snapshot"
]);

export const CapabilityRiskSchema = z.enum(["low", "medium", "high"]);
export const ConnectionKindSchema = z.enum(["serial", "adb", "fastboot", "evidence_store"]);

export const CapabilityRequiresSchema = z
  .object({
    connection: ConnectionKindSchema.optional()
  })
  .strict();

export const CapabilityLimitsSchema = z
  .object({
    default_timeout_sec: z.number().int().positive(),
    max_duration_sec: z.number().int().positive().optional()
  })
  .strict();

export const CapabilityDefinitionSchema = z
  .object({
    name: CapabilityNameSchema,
    description: z.string().min(1).optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    requires: CapabilityRequiresSchema.optional(),
    limits: CapabilityLimitsSchema,
    risk: CapabilityRiskSchema
  })
  .strict();

export const CapabilityStatusSchema = CapabilityDefinitionSchema.pick({
  name: true,
  requires: true,
  limits: true,
  risk: true
})
  .extend({
    available: z.boolean()
  })
  .strict();

export const RequestedActionSchema = z
  .object({
    capability: CapabilityNameSchema,
    input: z.record(z.string(), z.unknown())
  })
  .strict();

export type CapabilityName = z.infer<typeof CapabilityNameSchema>;
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>;
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;
export type CapabilityRequires = z.infer<typeof CapabilityRequiresSchema>;
export type CapabilityLimits = z.infer<typeof CapabilityLimitsSchema>;
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type RequestedAction = z.infer<typeof RequestedActionSchema>;
