export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

const LOG_LEVELS: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

export class Logger {
  constructor(private module: string, private minLevel: LogLevel = "INFO") {}

  error(msg: string, kv: Record<string, unknown> = {}): void {
    this.log("ERROR", msg, kv);
  }

  warn(msg: string, kv: Record<string, unknown> = {}): void {
    this.log("WARN", msg, kv);
  }

  info(msg: string, kv: Record<string, unknown> = {}): void {
    this.log("INFO", msg, kv);
  }

  debug(msg: string, kv: Record<string, unknown> = {}): void {
    this.log("DEBUG", msg, kv);
  }

  private log(level: LogLevel, msg: string, kv: Record<string, unknown>): void {
    if (LOG_LEVELS[level] > LOG_LEVELS[this.minLevel]) return;

    const timestamp = new Date().toISOString();
    const kvStr = Object.entries(kv)
      .map(([k, v]) => `${k}=${this.sanitize(v)}`)
      .join(" ");

    const line = `[${level}] [${timestamp}] [${this.module}] ${msg}${kvStr ? " " + kvStr : ""}`;
    if (level === "ERROR") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  private sanitize(value: unknown): string {
    if (typeof value === "string") {
      // Redact potential secrets
      return value.replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s"'`]+/gi, "$1[redacted]");
    }
    return String(value);
  }
}
