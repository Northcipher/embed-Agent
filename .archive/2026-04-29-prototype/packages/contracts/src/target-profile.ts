import { z } from "zod";

export const SerialConnectionSchema = z
  .object({
    port: z.string().min(1),
    baud: z.number().int().positive()
  })
  .strict();

export const AdbConnectionSchema = z
  .object({
    device_id: z.string().min(1)
  })
  .strict();

export const TargetConnectionsSchema = z
  .object({
    serial: SerialConnectionSchema.optional(),
    adb: AdbConnectionSchema.optional()
  })
  .strict();

export const FastbootFlashProfileSchema = z
  .object({
    method: z.literal("fastboot"),
    artifact_type: z.string().min(1).optional(),
    partition: z.string().min(1).optional()
  })
  .strict();

export const CustomFlashProfileSchema = z
  .object({
    method: z.literal("custom_command"),
    artifact_type: z.string().min(1).optional(),
    command: z
      .object({
        file: z.string().min(1),
        args: z.array(z.string())
      })
      .strict()
      .optional()
  })
  .strict();

export const TargetFlashProfileSchema = z.discriminatedUnion("method", [FastbootFlashProfileSchema, CustomFlashProfileSchema]);

export const TargetHintsSchema = z
  .object({
    boot_markers: z.array(z.string().min(1)).optional(),
    fail_patterns: z.array(z.string().min(1)).optional()
  })
  .strict();

export const TargetSafetySchema = z
  .object({
    allow_flash: z.boolean().optional(),
    allow_reboot: z.boolean().optional(),
    allow_shell_exec: z.boolean().optional(),
    allow_power_cycle: z.boolean().optional()
  })
  .strict();

export const TargetProfileSchema = z
  .object({
    target_id: z.string().min(1),
    connections: TargetConnectionsSchema.default({}),
    flash: TargetFlashProfileSchema.optional(),
    target_hints: TargetHintsSchema.default({}),
    safety: TargetSafetySchema.default({})
  })
  .strict();

export type SerialConnection = z.infer<typeof SerialConnectionSchema>;
export type AdbConnection = z.infer<typeof AdbConnectionSchema>;
export type TargetConnections = z.infer<typeof TargetConnectionsSchema>;
export type FastbootFlashProfile = z.infer<typeof FastbootFlashProfileSchema>;
export type CustomFlashProfile = z.infer<typeof CustomFlashProfileSchema>;
export type TargetFlashProfile = z.infer<typeof TargetFlashProfileSchema>;
export type TargetHints = z.infer<typeof TargetHintsSchema>;
export type TargetSafety = z.infer<typeof TargetSafetySchema>;
export type TargetProfile = z.infer<typeof TargetProfileSchema>;
