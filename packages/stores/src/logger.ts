export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const SENSITIVE_KEYS = new Set(["api_key", "token", "password", "secret", "authorization", "webhook_url"]);

function maskValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof value === "string" && value.length > 0) {
    return value.slice(0, 4) + "***";
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      masked[k] = maskValue(k, v);
    }
    return masked;
  }
  return value;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  pretty?: boolean;
  module?: string;
}

export class Logger {
  private minLevel: LogLevel;
  private pretty: boolean;
  private module: string;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel ?? "info";
    this.pretty = options.pretty ?? false;
    this.module = options.module ?? "embed-agent";
  }

  private log(level: LogLevel, message: string, kv?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const entry = {
      time: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...(kv ? maskValue("kv", kv) as Record<string, unknown> : {}),
    };

    if (this.pretty) {
      const extra = kv ? " " + JSON.stringify(maskValue("kv", kv)) : "";
      process.stderr.write(`[${entry.time}] ${level.toUpperCase()} [${this.module}] ${message}${extra}\n`);
    } else {
      process.stderr.write(JSON.stringify(entry) + "\n");
    }
  }

  debug(msg: string, kv?: Record<string, unknown>): void { this.log("debug", msg, kv); }
  info(msg: string, kv?: Record<string, unknown>): void { this.log("info", msg, kv); }
  warn(msg: string, kv?: Record<string, unknown>): void { this.log("warn", msg, kv); }
  error(msg: string, kv?: Record<string, unknown>): void { this.log("error", msg, kv); }
}
