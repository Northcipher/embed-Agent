import { generateText, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Tool call results from multi-step generation. */
  toolResults?: { toolCallId: string; toolName: string; args: unknown; result?: unknown }[];
  /** Anthropic prompt cache metrics. Present when model supports it. */
  cacheMetrics?: { cacheCreationTokens: number; cacheReadTokens: number; totalInputTokens: number };
}

export interface LLMCallOptions {
  model: string;
  timeout: number;
  maxTokens: number;
  tools?: ToolSet;
  /** AI SDK v6 stopWhen condition (e.g. isStepCount(N)). Passed through to generateText. */
  stopWhen?: unknown;
}

export interface LLMProvider {
  call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse>;
}

// Shared helper: call generateText and normalize the response. stopWhen/tools flow through req.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callAI(req: any, modelName: string): Promise<LLMResponse> {
  const result = await generateText(req);
  const usage = result.usage;
  const resp: LLMResponse = {
    content: result.text,
    model: result.response?.modelId ?? modelName,
  };
  if (usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
    resp.usage = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens };
  }
  // Extract tool results for structured output extraction
  const rawResult = result as unknown as Record<string, unknown>;
  if (rawResult.toolResults && Array.isArray(rawResult.toolResults)) {
    resp.toolResults = (rawResult.toolResults as Array<Record<string, unknown>>).map(tr => ({
      toolCallId: (tr.toolCallId as string) ?? "",
      toolName: (tr.toolName as string) ?? "",
      args: tr.args,
      result: tr.result,
    }));
  }
  return resp;
}

// ============================================================
// AI SDK Anthropic Provider
// ============================================================

export class AIAnthropicProvider implements LLMProvider {
  constructor(private apiKey: string, private baseURL?: string) {}

  async call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anthropicOpts: any = { apiKey: this.apiKey };
    if (this.baseURL) anthropicOpts.baseURL = this.baseURL;
    const model = createAnthropic(anthropicOpts)(options.model);
    const systemMsg = messages.find(m => m.role === "system");
    const nonSystem = messages.filter(m => m.role !== "system") as { role: "user" | "assistant"; content: string }[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = {
      model,
      messages: nonSystem,
      maxOutputTokens: options.maxTokens,
      abortSignal: AbortSignal.timeout(options.timeout * 1000),
    };
    if (systemMsg) req.system = systemMsg.content;

    if (options.stopWhen) req.stopWhen = options.stopWhen;
    if (options.tools) req.tools = options.tools;
    return callAI(req, options.model);
  }
}

// ============================================================
// AI SDK OpenAI Provider
// ============================================================

export class AIOpenAIProvider implements LLMProvider {
  constructor(private apiKey: string, private baseURL?: string) {}

  async call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openaiOpts: any = { apiKey: this.apiKey };
    if (this.baseURL) openaiOpts.baseURL = this.baseURL;
    const model = createOpenAI(openaiOpts)(options.model);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = {
      model,
      messages: messages as { role: string; content: string }[],
      maxOutputTokens: options.maxTokens,
      abortSignal: AbortSignal.timeout(options.timeout * 1000),
    };

    if (options.stopWhen) req.stopWhen = options.stopWhen;
    if (options.tools) req.tools = options.tools;
    return callAI(req, options.model);
  }
}

// ============================================================
// AI SDK OpenAI-Compatible Provider (LiteLLM, proxies, gateways)
// ============================================================

export class AIOpenAICompatibleProvider implements LLMProvider {
  constructor(private baseURL: string, private apiKey: string) {}

  async call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse> {
    const model = createOpenAICompatible({
      baseURL: this.baseURL,
      name: "openai-compatible",
      apiKey: this.apiKey,
    })(options.model);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = {
      model,
      messages: messages as { role: string; content: string }[],
      maxOutputTokens: options.maxTokens,
      abortSignal: AbortSignal.timeout(options.timeout * 1000),
    };

    if (options.stopWhen) req.stopWhen = options.stopWhen;
    if (options.tools) req.tools = options.tools;
    return callAI(req, options.model);
  }
}

// ============================================================
// DeepSeek Anthropic-compatible Provider (raw fetch, no AI SDK wrapper)
// The AI SDK Anthropic provider adds tool_choice/cache_control params
// that DeepSeek doesn't handle. This provider sends clean requests.
// ============================================================

export class DeepSeekProvider implements LLMProvider {
  constructor(private apiKey: string, private baseURL = "https://api.deepseek.com/anthropic") {}

  async call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse> {
    const systemMsg = messages.find(m => m.role === "system");
    const userMsgs = messages.filter(m => m.role !== "system").map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: userMsgs,
    };
    if (systemMsg) body.system = systemMsg.content;
    if (options.tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body.tools = Object.entries(options.tools as Record<string, any>).map(([name, t]) => {
        let schema = t.inputSchema ?? t.parameters ?? { type: "object", properties: {} };
        // Convert Zod schema to plain JSON schema
        if (typeof schema === "object" && "_def" in schema) schema = JSON.parse(JSON.stringify(schema));
        return { name, description: t.description ?? "", input_schema: schema };
      });
    }
    // DeepSeek works better with explicit low temperature for tool_use
    body.temperature = 0.1;

    const resp = await fetch(`${this.baseURL}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout * 1000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`DeepSeek API ${resp.status}: ${errText.slice(0, 500)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await resp.json();
    const content = json.content ?? [];
    const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const toolUses = content.filter((c: any) => c.type === "tool_use");

    // Build content: include tool_use summaries so outputChars > 0 for audit logging
    const toolSummaries = toolUses.map((tu: any) =>
      `[tool_use:${tu.name}] ${JSON.stringify(tu.input ?? {})}`
    ).join("\n");
    const fullContent = [textParts, toolSummaries].filter(Boolean).join("\n");

    const resp2: LLMResponse = {
      content: fullContent,
      model: json.model ?? options.model,
    };
    if (toolUses.length > 0) {
      resp2.toolResults = toolUses.map((tu: any) => ({
        toolCallId: tu.id ?? "",
        toolName: tu.name ?? "",
        args: tu.input ?? {},
      }));
    }
    if (json.usage) {
      resp2.usage = { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens };
      // Extract Anthropic prompt cache metrics
      const ccr = json.usage.cache_creation_input_tokens ?? 0;
      const cr = json.usage.cache_read_input_tokens ?? 0;
      const total = json.usage.input_tokens ?? 0;
      if (ccr > 0 || cr > 0) {
        resp2.cacheMetrics = { cacheCreationTokens: ccr, cacheReadTokens: cr, totalInputTokens: total };
      }
    }
    return resp2;
  }
}

// ============================================================
// DeepSeek OpenAI-compatible Provider (raw fetch, /v1/chat/completions)
// ============================================================

export class DeepSeekOpenAIProvider implements LLMProvider {
  constructor(private apiKey: string, private baseURL = "https://api.deepseek.com") {}

  async call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: 0.1,
    };
    if (options.tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body.tools = Object.entries(options.tools as Record<string, any>).map(([_name, t]) => {
        let schema = t.inputSchema ?? t.parameters ?? { type: "object", properties: {} };
        if (typeof schema === "object" && "_def" in schema) schema = JSON.parse(JSON.stringify(schema));
        return { type: "function", function: { name: _name, description: t.description ?? "", parameters: schema } };
      });
    }

    const resp = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout * 1000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`DeepSeek OpenAI ${resp.status}: ${errText.slice(0, 500)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await resp.json();
    const choice = json.choices?.[0]?.message ?? {};
    const textContent = choice.content ?? "";
    const toolCalls: any[] = choice.tool_calls ?? [];

    const toolSummaries = toolCalls.map((tc: any) =>
      `[tool_call:${tc.function?.name}] ${tc.function?.arguments ?? "{}"}`
    ).join("\n");
    const fullContent = [textContent, toolSummaries].filter(Boolean).join("\n");

    const resp2: LLMResponse = {
      content: fullContent,
      model: json.model ?? options.model,
    };
    if (toolCalls.length > 0) {
      resp2.toolResults = toolCalls.map((tc: any) => ({
        toolCallId: tc.id ?? "",
        toolName: tc.function?.name ?? "",
        args: (() => { try { return JSON.parse(tc.function?.arguments ?? "{}"); } catch { return {}; } })(),
      }));
    }
    if (json.usage) {
      resp2.usage = { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens };
    }
    return resp2;
  }
}

// ============================================================
// Mock Provider (unchanged — for tests)
// ============================================================

export class MockProvider implements LLMProvider {
  private responses: string[] = [];
  private idx = 0;

  setResponse(text: string): void { this.responses = [text]; this.idx = 0; }
  setResponses(texts: string[]): void { this.responses = texts; this.idx = 0; }
  queueResponse(text: string): void { this.responses.push(text); }

  async call(_messages: LLMMessage[], _options: { model: string; timeout: number; maxTokens: number }): Promise<LLMResponse> {
    const content = this.responses[this.idx] ?? this.responses[this.responses.length - 1] ?? "{}";
    if (this.idx < this.responses.length - 1) this.idx++;
    return { content, model: "mock", usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

// ============================================================
// CB4: LLM Circuit Breaker (unchanged)
// ============================================================

export class LLMCircuitBreaker {
  private failures = 0;
  private degraded = false;
  private degradedSince = 0;
  private probing = false;
  private readonly maxFailures: number;
  private readonly probeAfterMs: number;

  constructor(maxFailures = 3, probeAfterSec = 300) {
    this.maxFailures = maxFailures;
    this.probeAfterMs = probeAfterSec * 1000;
  }

  recordFailure(): void {
    this.failures++;
    if (this.probing) {
      this.degraded = true;
      this.degradedSince = Date.now();
      this.probing = false;
      return;
    }
    if (this.failures >= this.maxFailures) {
      this.degraded = true;
      this.degradedSince = Date.now();
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.degraded = false;
    this.probing = false;
  }

  allowCall(): boolean {
    if (!this.degraded) return true;
    if (Date.now() - this.degradedSince >= this.probeAfterMs) {
      if (!this.probing) {
        this.probing = true;
        return true;
      }
      return false;
    }
    return false;
  }

  isDegraded(): boolean { return this.degraded; }

  reset(): void {
    this.failures = 0;
    this.degraded = false;
    this.probing = false;
  }
}

// ============================================================
// LLMCallManager (unchanged)
// ============================================================

export class LLMCallManager {
  private breakers = new Map<string, LLMCircuitBreaker>();
  private retryConfig: { maxRetries: number; backoffMs: number[] };

  constructor(
    private provider: LLMProvider,
    private models: {
      planner: { model: string; timeout: number; maxTokens?: number };
      observer: { model: string; timeout: number; maxTokens?: number };
      reply: { model: string; timeout: number; maxTokens?: number };
    },
    retryConfig?: { maxRetries?: number; backoffMs?: number[] },
    private cbConfig?: { maxFailures?: number; probeAfterSec?: number },
  ) {
    this.retryConfig = {
      maxRetries: retryConfig?.maxRetries ?? 2,
      backoffMs: retryConfig?.backoffMs ?? [1000, 3000],
    };
  }

  private breaker(role: string): LLMCircuitBreaker {
    let b = this.breakers.get(role);
    if (!b) { b = new LLMCircuitBreaker(this.cbConfig?.maxFailures, this.cbConfig?.probeAfterSec); this.breakers.set(role, b); }
    return b;
  }

  async call(
    role: "planner" | "observer" | "reply",
    messages: LLMMessage[],
    opts?: { tools?: ToolSet; stopWhen?: unknown },
  ): Promise<LLMResponse | { status: "degraded"; reason: string }> {
    const br = this.breaker(role);
    if (!br.allowCall()) {
      return { status: "degraded", reason: `CB4: ${role} LLM service degraded` };
    }

    const cfg = this.models[role];
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const resp = await this.provider.call(messages, {
          model: cfg.model,
          timeout: cfg.timeout,
          maxTokens: cfg.maxTokens ?? 4096,
          ...(opts?.tools ? { tools: opts.tools } : {}),
          ...(opts?.stopWhen != null ? { stopWhen: opts.stopWhen } : {}),
        });
        br.recordSuccess();
        return resp;
      } catch (e) {
        lastError = e;
        if (this.isAbortError(e)) {
          // Timeouts are often transient — retry once before recording failure
          if (attempt >= 1) {
            br.recordFailure();
            throw e;
          }
        }
        const isRetryable = this.isRetryableError(e);
        if (!isRetryable || attempt >= this.retryConfig.maxRetries) {
          br.recordFailure();
          throw e;
        }
        const delay = this.retryConfig.backoffMs[attempt] ?? this.retryConfig.backoffMs[this.retryConfig.backoffMs.length - 1]!;
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastError;
  }

  /** Call without circuit breaker — used for auto-degrade retries. */
  async callBypassBreaker(
    role: "planner" | "observer" | "reply",
    messages: LLMMessage[],
    opts?: { tools?: ToolSet; stopWhen?: unknown },
  ): Promise<LLMResponse | { status: "degraded"; reason: string }> {
    const cfg = this.models[role];

    try {
      const resp = await this.provider.call(messages, {
        model: cfg.model,
        timeout: cfg.timeout,
        maxTokens: cfg.maxTokens ?? 4096,
        ...(opts?.tools ? { tools: opts.tools } : {}),
        ...(opts?.stopWhen != null ? { stopWhen: opts.stopWhen } : {}),
      });
      return resp;
    } catch (e) {
      return { status: "degraded", reason: `Bypass call failed: ${(e as Error).message}` };
    }
  }

  private isAbortError(e: unknown): boolean {
    const msg = (e as Error).message ?? String(e);
    return msg.includes("abort") || msg.includes("Abort") || msg.includes("timeout") || msg.includes("Timeout");
  }

  private isRetryableError(e: unknown): boolean {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("429") || msg.includes("rate") || msg.includes("Rate")) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("socket")) return true;
    if (msg.includes("overloaded") || msg.includes("capacity")) return true;
    return false;
  }

  isDegraded(role?: string): boolean {
    if (role) return this.breaker(role).isDegraded();
    return [...this.breakers.values()].some(b => b.isDegraded());
  }
}
