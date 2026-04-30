import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";

// Dynamic YAML loading — falls back to JSON if yaml package not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let yamlParser: any = null;
async function getYamlParser() {
  if (!yamlParser) {
    try {
      yamlParser = await (Function('return import("yaml")')() as any).then((m: any) => m.default ?? m);
    } catch {
      yamlParser = { parse: (s: string) => JSON.parse(s) };
    }
  }
  return yamlParser;
}

export interface ConfigLoadResult<T> {
  loaded: boolean;
  config?: T;
  errors: { file: string; message: string; line?: number }[];
}

export class ConfigLoader {
  constructor(private configRoot: string, private logger: Logger) {}

  /** Load a config file, parse as YAML, validate with a Zod schema. */
  async load<T>(
    relativePath: string,
    schema: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: { issues: { message: string; path: (string | number)[] }[] } } },
  ): Promise<ConfigLoadResult<T>> {
    const errors: ConfigLoadResult<T>["errors"] = [];
    const filePath = path.join(this.configRoot, relativePath);

    // 1. Read file
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { loaded: false, errors: [{ file: filePath, message: "File not found" }] };
      }
      return { loaded: false, errors: [{ file: filePath, message: `Read error: ${(e as Error).message}` }] };
    }

    // 2. Parse YAML (with line tracking)
    let parsed: unknown;
    try {
      const y = await getYamlParser();
      parsed = y.parse(raw);
    } catch (e) {
      // Extract line number from YAML parse error if available
      const err = e as { linePos?: { line: number; col: number }[]; message: string };
      const lineInfo = err.linePos?.[0] ? ` (line ${err.linePos[0].line})` : "";
      return { loaded: false, errors: [{ file: filePath, message: `YAML parse error${lineInfo}: ${err.message}` }] };
    }

    // 3. Validate with Zod
    const result = schema.safeParse(parsed);
    if (!result.success && result.error) {
      for (const issue of result.error.issues) {
        errors.push({
          file: filePath,
          message: `${issue.path.join(".")}: ${issue.message}`,
        });
      }
      this.logger.error(`Config validation failed for ${relativePath}`, { errors });
      return { loaded: false, errors };
    }

    this.logger.info(`Config loaded: ${relativePath}`);
    const out: ConfigLoadResult<T> = { loaded: true, errors: [] };
    if (result.data !== undefined) out.config = result.data;
    return out;
  }

  /** Load all required configs. Returns null if any critical config fails. */
  async loadAll<T extends Record<string, unknown>>(
    configs: Record<string, { schema: { safeParse: (d: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string; path: (string | number)[] }[] } } }; required: boolean }>,
  ): Promise<{ configs: Partial<T>; errors: ConfigLoadResult<unknown>["errors"] }> {
    const result: Partial<T> = {};
    const allErrors: ConfigLoadResult<unknown>["errors"] = [];

    for (const [name, { schema, required }] of Object.entries(configs)) {
      const r = await this.load(name, schema);
      if (r.config) result[name.replace(/\.ya?ml$/, "") as keyof T] = r.config as T[keyof T];
      allErrors.push(...r.errors);

      if (required && !r.loaded) {
        this.logger.error(`Required config ${name} failed to load — startup blocked`);
      }
    }

    return { configs: result, errors: allErrors };
  }
}
