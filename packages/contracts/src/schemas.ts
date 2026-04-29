import { z } from "zod/v4";

// Target Profile Schema
export const TargetProfileSchema = z.object({
  target_id: z.string(),
  display_name: z.string().optional(),
  connections: z.object({
    serial: z.object({ port: z.string(), baud: z.number() }).optional(),
    adb: z.object({ device_id: z.string() }).optional(),
    fastboot: z.object({ device_id: z.string() }).optional(),
    ssh: z.object({ host: z.string(), port: z.number() }).optional(),
  }),
  flash: z.object({
    method: z.enum(["fastboot", "custom_command"]),
    artifact_type: z.string(),
  }).optional(),
  recovery: z.object({
    reboot_method: z.enum(["adb", "fastboot", "custom_command"]).optional(),
    stable_artifact: z.string().optional(),
  }).optional(),
  safety: z.object({
    allow_flash: z.boolean(),
    allow_reboot: z.boolean(),
    allow_shell_exec: z.boolean(),
    allow_power_cycle: z.boolean(),
  }),
  target_hints: z.object({
    boot_markers: z.string().array().optional(),
    boot_sequence: z.object({
      stage: z.string(),
      expected_duration: z.number(),
    }).array().optional(),
    fail_patterns: z.string().array().optional(),
    known_quirks: z.string().array().optional(),
    recommended_checks: z.string().array().optional(),
  }).optional(),
  skills: z.string().array().optional(),
});

// LLM Config Schema
export const LLMConfigSchema = z.object({
  default_provider: z.string(),
  providers: z.record(z.string(), z.object({
    type: z.string(),
    api_key_env: z.string(),
    models: z.object({
      planner: z.string(),
      observer: z.string(),
      reply: z.string(),
    }),
    timeout: z.object({
      planner: z.number(),
      observer: z.number(),
      reply: z.number(),
    }),
  })),
  observer_policy: z.object({
    debounce_sec: z.number(),
    max_concurrent_per_run: z.number(),
    default_checkpoint_interval: z.number(),
  }),
});

// Hook Config Schema
export const HookPointEnum = z.enum([
  "PreRunStart", "PostRunEnd",
  "PreStepExecute", "PostStepComplete", "PostStepFailed",
  "OnStopDecision", "OnFinalizing",
  "RuntimeStart",
]);

export const HookConfigSchema = z.object({
  hooks: z.array(z.object({
    name: z.string(),
    on: HookPointEnum,
    match: z.record(z.string(), z.string()).optional(),
    command: z.string(),
    timeout: z.number(),
  })),
});
