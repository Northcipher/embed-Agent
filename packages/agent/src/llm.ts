export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface LLMProvider {
  call(messages: LLMMessage[], options: { model: string; timeout: number; maxTokens: number }): Promise<LLMResponse>;
}

// --- Anthropic Provider ---

export class AnthropicProvider implements LLMProvider {
  constructor(private apiKey: string, private baseUrl?: string) {}

  async call(messages: LLMMessage[], options: { model: string; timeout: number; maxTokens: number }): Promise<LLMResponse> {
    // Dynamic import to avoid requiring the SDK at module load
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Anthropic = (await import("@anthropic-ai/sdk") as any).default;
    const client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseUrl, timeout: options.timeout * 1000 });

    const systemMsg = messages.find(m => m.role === "system");
    const userMsgs = messages.filter(m => m.role !== "system");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
    };
    if (systemMsg?.content) req.system = systemMsg.content;

    const resp = await client.messages.create(req);
    const textBlock = resp.content?.find?.((b: { type: string }) => b.type === "text");
    const result: LLMResponse = { content: textBlock?.text ?? "", model: resp.model as string };
    if (resp.usage) result.usage = { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens };
    return result;
  }
}

// --- Mock Provider for testing ---

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

// --- CB4: LLM Circuit Breaker ---

export class LLMCircuitBreaker {
  private failures = 0;
  private degraded = false;
  private degradedSince = 0;
  private probing = false; // true during a single probe attempt
  private readonly MAX_FAILURES = 3;
  private readonly PROBE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

  recordFailure(): void {
    this.failures++;
    if (this.probing) {
      // Probe failed — re-enter degraded immediately
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

  /** Returns true if the breaker allows a call through (either healthy or probe). */
  allowCall(): boolean {
    if (!this.degraded) return true;
    // Allow a single probe after the recovery interval
    if (Date.now() - this.degradedSince >= this.PROBE_AFTER_MS) {
      if (!this.probing) {
        this.probing = true;
        return true; // allow probe
      }
      // Already probing — don't allow another until probe completes
      return false;
    }
    return false;
  }

  isDegraded(): boolean { return this.degraded && !this.probing; }

  reset(): void {
    this.failures = 0;
    this.degraded = false;
    this.probing = false;
  }
}

// --- LLMCallManager ---

export class LLMCallManager {
  private breakers = new Map<string, LLMCircuitBreaker>();

  constructor(
    private provider: LLMProvider,
    private models: {
      planner: { model: string; timeout: number; maxTokens?: number };
      observer: { model: string; timeout: number; maxTokens?: number };
      reply: { model: string; timeout: number; maxTokens?: number };
    },
  ) {}

  private breaker(role: string): LLMCircuitBreaker {
    let b = this.breakers.get(role);
    if (!b) { b = new LLMCircuitBreaker(); this.breakers.set(role, b); }
    return b;
  }

  async call(
    role: "planner" | "observer" | "reply",
    messages: LLMMessage[],
  ): Promise<LLMResponse | { status: "degraded"; reason: string }> {
    const br = this.breaker(role);
    if (!br.allowCall()) {
      return { status: "degraded", reason: `CB4: ${role} LLM service degraded` };
    }

    const cfg = this.models[role];
    try {
      const resp = await this.provider.call(messages, {
        model: cfg.model,
        timeout: cfg.timeout,
        maxTokens: cfg.maxTokens ?? 4096,
      });
      br.recordSuccess();
      return resp;
    } catch (e) {
      br.recordFailure();
      throw e;
    }
  }

  isDegraded(role?: string): boolean {
    if (role) return this.breaker(role).isDegraded();
    return [...this.breakers.values()].some(b => b.isDegraded());
  }
}
