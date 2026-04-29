import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ObserverRunner } from "./observer-runner.js";
import { AnthropicProvider, GatewayProvider, MockProvider, OpenAIProvider } from "./providers.js";
import { ReplyGeneratorRunner } from "./reply-generator-runner.js";
import { TaskPlannerRunner } from "./task-planner-runner.js";
import type { LlmProvider } from "./types.js";

const ProviderIdSchema = z.string().min(1);

const BaseProviderConfigSchema = z
  .object({
    model: z.string().min(1),
    api_key_env: z.string().min(1).optional()
  })
  .strict();

const AnthropicProviderConfigSchema = BaseProviderConfigSchema.extend({
  type: z.literal("anthropic"),
  max_tokens: z.number().int().positive().optional()
}).strict();

const OpenAIProviderConfigSchema = BaseProviderConfigSchema.extend({
  type: z.literal("openai")
}).strict();

const GatewayProviderConfigSchema = BaseProviderConfigSchema.extend({
  type: z.literal("gateway"),
  base_url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional()
}).strict();

const MockProviderConfigSchema = z
  .object({
    type: z.literal("mock"),
    model: z.string().min(1),
    outputs: z.array(z.string()).default([])
  })
  .strict();

export const LlmProviderConfigSchema = z.discriminatedUnion("type", [
  AnthropicProviderConfigSchema,
  OpenAIProviderConfigSchema,
  GatewayProviderConfigSchema,
  MockProviderConfigSchema
]);

export const LlmIntegrationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    default_provider: ProviderIdSchema,
    roles: z
      .object({
        task_planner: ProviderIdSchema.optional(),
        observer: ProviderIdSchema.optional(),
        reply_generator: ProviderIdSchema.optional()
      })
      .strict()
      .default({}),
    providers: z.record(ProviderIdSchema, LlmProviderConfigSchema)
  })
  .strict();

export type LlmProviderConfig = z.infer<typeof LlmProviderConfigSchema>;
export type LlmIntegrationConfig = z.infer<typeof LlmIntegrationConfigSchema>;

export type LlmRunnerFactoryOptions = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export type ConfiguredLlmRunners = {
  taskPlanner?: TaskPlannerRunner;
  observer?: ObserverRunner;
  replyGenerator?: ReplyGeneratorRunner;
};

export async function loadLlmConfig(filePath: string): Promise<LlmIntegrationConfig> {
  const raw = await readFile(filePath, "utf8");
  return parseLlmConfig(parseYaml(raw));
}

export function parseLlmConfig(value: unknown): LlmIntegrationConfig {
  return LlmIntegrationConfigSchema.parse(value);
}

export function createLlmRunnersFromConfig(config: LlmIntegrationConfig, options: LlmRunnerFactoryOptions = {}): ConfiguredLlmRunners {
  if (!config.enabled) {
    return {};
  }

  const providers = new Map<string, LlmProvider>();
  const providerForRole = (role: keyof NonNullable<LlmIntegrationConfig["roles"]>): { provider: LlmProvider; model: string } => {
    const providerId = config.roles[role] ?? config.default_provider;
    const providerConfig = config.providers[providerId];
    if (providerConfig === undefined) {
      throw new Error(`LLM provider ${providerId} for ${role} is not configured`);
    }
    let provider = providers.get(providerId);
    if (provider === undefined) {
      provider = createLlmProvider(providerId, providerConfig, options.env ?? process.env);
      providers.set(providerId, provider);
    }
    return { provider, model: providerConfig.model };
  };

  const taskPlanner = providerForRole("task_planner");
  const observer = providerForRole("observer");
  const replyGenerator = providerForRole("reply_generator");

  return {
    taskPlanner: new TaskPlannerRunner({ provider: taskPlanner.provider, model: taskPlanner.model, ...optionalNow(options.now) }),
    observer: new ObserverRunner({ provider: observer.provider, model: observer.model, ...optionalNow(options.now) }),
    replyGenerator: new ReplyGeneratorRunner({ provider: replyGenerator.provider, model: replyGenerator.model, ...optionalNow(options.now) })
  };
}

export function createLlmProvider(providerId: string, config: LlmProviderConfig, env: Record<string, string | undefined> = process.env): LlmProvider {
  if (config.type === "mock") {
    return new MockProvider(config.outputs);
  }

  const apiKey = readConfiguredApiKey(providerId, config.api_key_env, env);
  if (config.type === "anthropic") {
    return new AnthropicProvider({
      providerId,
      ...optionalApiKey(apiKey),
      ...(config.max_tokens === undefined ? {} : { maxTokens: config.max_tokens })
    });
  }
  if (config.type === "openai") {
    return new OpenAIProvider({
      providerId,
      ...optionalApiKey(apiKey)
    });
  }
  return new GatewayProvider({
    providerId,
    baseUrl: config.base_url,
    ...optionalApiKey(apiKey),
    ...(config.headers === undefined ? {} : { headers: config.headers })
  });
}

function optionalNow(now: (() => Date) | undefined): { now?: () => Date } {
  return now === undefined ? {} : { now };
}

function optionalApiKey(apiKey: string | undefined): { apiKey?: string } {
  return apiKey === undefined ? {} : { apiKey };
}

function readConfiguredApiKey(
  providerId: string,
  apiKeyEnv: string | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  if (apiKeyEnv === undefined) {
    return undefined;
  }
  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`LLM provider ${providerId} requires environment variable ${apiKeyEnv}`);
  }
  return apiKey;
}
