import { z } from "zod/v4";

// Target Profile Schema — accepts single object or array of targets
const TargetProfileObjectSchema = z.object({
  target_id: z.string(),
  display_name: z.string().optional(),
  connections: z.object({
    serial: z.object({ port: z.string(), baudRate: z.number() }).optional(),
    adb: z.object({ device_id: z.string() }).optional(),
    fastboot: z.object({ device_id: z.string() }).optional(),
    ssh: z.object({
      host: z.string(), port: z.number(),
      username: z.string().optional(), password: z.string().optional(),
      privateKeyPath: z.string().optional(),
      hostKeyPolicy: z.object({ type: z.enum(["skip", "accept-new", "trust-on-first-use", "strict"]) }).optional(),
      commandPolicy: z.object({ allowed_commands: z.string().array() }).optional(),
    }).optional(),
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

export const TargetProfileSchema = z.union([TargetProfileObjectSchema, z.array(TargetProfileObjectSchema)]);

// LLM Config Schema
export const LLMConfigSchema = z.object({
  default_provider: z.string(),
  providers: z.record(z.string(), z.object({
    type: z.enum(["anthropic", "openai", "openai-compatible", "mock", "deepseek", "deepseek-openai"]),
    api_key_env: z.string(),
    base_url: z.string().optional(),
    models: z.object({
      planner: z.string(),
      observer: z.string(),
      reply: z.string(),
    }),
    timeout: z.object({
      planner: z.number(),
      observer: z.number(),
      reply: z.number(),
    }).optional(),
  })),
});

// System Config Schema
export const SystemConfigSchema = z.object({
  runtime: z.object({
    retry: z.object({
      max_retries: z.number(),
      intervals_sec: z.number().array(),
      retryable: z.string().array(),
    }),
    rule_policy: z.object({
      fatal_patterns: z.string().array(),
      warning_patterns: z.string().array(),
      silence_timeout_sec: z.number(),
    }),
    ring_buffer: z.object({
      max_lines: z.number(),
      default_before: z.number(),
      default_after: z.number(),
    }),
    step_executor: z.object({
      max_timeout_sec: z.number(),
      default_timeout_sec: z.number(),
    }),
  }),
  storage: z.object({
    data_root: z.string(),
    max_evidence_bytes: z.number(),
    cleanup: z.object({
      keep_completed_days: z.number(),
      keep_failed_days: z.number(),
      max_episodes_per_target: z.number(),
    }),
  }),
  notifications: z.object({
    enabled: z.boolean(),
    channels: z.object({
      slack: z.object({ webhook_url_env: z.string() }).optional(),
      email: z.object({ smtp_host: z.string(), smtp_port: z.number() }).optional(),
    }).optional(),
    throttle: z.object({
      run_result_sec: z.number(),
      target_offline_sec: z.number(),
      memory_suggestion_sec: z.number(),
    }).optional(),
  }),
  security: z.object({
    allowed_shell_commands: z.string().array(),
    max_command_length: z.number(),
    block_unsafe_patterns: z.boolean(),
  }),
  observer: z.object({
    debounce_sec: z.number(),
    max_concurrent_per_run: z.number(),
    default_checkpoint_interval_sec: z.number(),
    circuit_breaker: z.object({
      max_failures: z.number(),
      probe_after_sec: z.number(),
    }),
    warning_escalation: z.object({
      threshold: z.number(),
      window_sec: z.number(),
    }),
  }),
  prompt_version: z.string().optional(),
});

// System config type
export type SystemConfig = z.infer<typeof SystemConfigSchema>;

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
