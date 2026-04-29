import fs from "node:fs/promises";
import path from "node:path";
import { TargetProfileSchema, LLMConfigSchema, HookConfigSchema } from "@embed-agent/contracts";
import type { TargetProfile } from "@embed-agent/contracts";
import type { z } from "zod/v4";

export class ConfigLoader {
  constructor(private configDir: string) {}

  async loadTargetProfile(targetId: string): Promise<TargetProfile> {
    const filePath = path.join(this.configDir, "targets", targetId, "profile.json");
    const result = await this.loadAndValidate(filePath, TargetProfileSchema);
    return result;
  }

  async loadLLMConfig(): Promise<z.infer<typeof LLMConfigSchema>> {
    const filePath = path.join(this.configDir, "llm.json");
    const result = await this.loadAndValidate(filePath, LLMConfigSchema);
    return result;
  }

  async loadHookConfig(): Promise<z.infer<typeof HookConfigSchema>> {
    const filePath = path.join(this.configDir, "hooks.json");
    try {
      return await this.loadAndValidate(filePath, HookConfigSchema);
    } catch {
      return { hooks: [] };
    }
  }

  private async loadAndValidate<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
    const content = await fs.readFile(filePath, "utf-8");
    const raw = JSON.parse(content) as unknown;
    const result = schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Config validation failed for ${filePath}:\n${issues}`);
    }
    return result.data;
  }
}
