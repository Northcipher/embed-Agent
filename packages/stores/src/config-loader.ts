import fs from "node:fs/promises";
import path from "node:path";
import { TargetProfileSchema, LLMConfigSchema, HookConfigSchema } from "@embed-agent/contracts";
import type { TargetProfile } from "@embed-agent/contracts";
import type { z, ZodIssue } from "zod/v4";

export class ConfigLoader {
  constructor(private configDir: string) {}

  async loadTargetProfile(targetId: string): Promise<TargetProfile> {
    const filePath = path.join(this.configDir, "targets", targetId, "profile.json");
    return this.loadAndValidate(filePath, TargetProfileSchema) as Promise<TargetProfile>;
  }

  async loadLLMConfig(): Promise<z.infer<typeof LLMConfigSchema>> {
    const filePath = path.join(this.configDir, "llm.json");
    return this.loadAndValidate(filePath, LLMConfigSchema) as Promise<z.infer<typeof LLMConfigSchema>>;
  }

  async loadHookConfig(): Promise<z.infer<typeof HookConfigSchema>> {
    const filePath = path.join(this.configDir, "hooks.json");
    try {
      return this.loadAndValidate(filePath, HookConfigSchema) as Promise<z.infer<typeof HookConfigSchema>>;
    } catch {
      return { hooks: [] } as z.infer<typeof HookConfigSchema>;
    }
  }

  private async loadAndValidate<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
    const content = await fs.readFile(filePath, "utf-8");
    const raw = JSON.parse(content) as unknown;
    const result = schema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.issues.map((i: ZodIssue) =>
        `  ${i.path.map(String).join(".")}: ${i.message}`
      ).join("\n");
      throw new Error(`Config validation failed for ${filePath}:\n${msg}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.data as any;
  }
}
