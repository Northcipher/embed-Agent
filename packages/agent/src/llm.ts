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
}

export interface LLMCallOptions {
  model: string;
  timeout: number;
  maxTokens: number;
  tools?: ToolSet;
  maxSteps?: number;
}

export interface LLMProvider {
  call(messages: LLMMessage[], options: LLMCallOptions): Promise<LLMResponse>;
}

// Shared helper: call generateText and normalize the response
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callAI(req: any, modelName: string, tools?: ToolSet, maxSteps?: number): Promise<LLMResponse> {
  if (tools) req.tools = tools;
  if (maxSteps != null) req.maxSteps = maxSteps;
  const result = await generateText(req);
  const usage = result.usage;
  const resp: LLMResponse = {
    content: result.text,
    model: result.response?.modelId ?? modelName,
  };
  if (usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
    resp.usage = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens };
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

    return callAI(req, options.model, options.tools, options.maxSteps);
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

    return callAI(req, options.model, options.tools, options.maxSteps);
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

    return callAI(req, options.model, options.tools, options.maxSteps);
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
  private readonly MAX_FAILURES = 3;
  private readonly PROBE_AFTER_MS = 5 * 60 * 1000;

  recordFailure(): void {
    this.failures++;
    if (this.probing) {
      this.degraded = true;
      this.degradedSince = Date.now();
      this.probing = false;
      return;
    }
    if (this.failures >= this.MAX_FAILURES) {
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
    if (Date.now() - this.degradedSince >= this.PROBE_AFTER_MS) {
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
  ) {
    this.retryConfig = {
      maxRetries: retryConfig?.maxRetries ?? 2,
      backoffMs: retryConfig?.backoffMs ?? [1000, 3000],
    };
  }

  private breaker(role: string): LLMCircuitBreaker {
    let b = this.breakers.get(role);
    if (!b) { b = new LLMCircuitBreaker(); this.breakers.set(role, b); }
    return b;
  }

  async call(
    role: "planner" | "observer" | "reply",
    messages: LLMMessage[],
    opts?: { tools?: ToolSet; maxSteps?: number },
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
          ...(opts?.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
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
    opts?: { tools?: ToolSet; maxSteps?: number },
  ): Promise<LLMResponse | { status: "degraded"; reason: string }> {
    const cfg = this.models[role];

    try {
      const resp = await this.provider.call(messages, {
        model: cfg.model,
        timeout: cfg.timeout,
        maxTokens: cfg.maxTokens ?? 4096,
        ...(opts?.tools ? { tools: opts.tools } : {}),
        ...(opts?.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
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
