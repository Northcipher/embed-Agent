import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LlmCallInput, LlmCallResult, LlmProvider } from "./types.js";

export class MockProvider implements LlmProvider {
  readonly providerId = "mock";

  private readonly outputs: string[];

  constructor(outputs: string[]) {
    this.outputs = [...outputs];
  }

  async completeJson(input: LlmCallInput): Promise<LlmCallResult> {
    const rawText = this.outputs.shift();
    if (rawText === undefined) {
      throw new Error(`MockProvider has no output for ${input.callId}`);
    }
    return {
      providerId: this.providerId,
      model: input.model,
      rawText,
      finishReason: "mock"
    };
  }
}

export class GatewayProvider implements LlmProvider {
  readonly providerId: string;

  constructor(
    private readonly config: {
      providerId?: string;
      baseUrl: string;
      apiKey?: string;
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
    }
  ) {
    this.providerId = config.providerId ?? "gateway";
  }

  async completeJson(input: LlmCallInput): Promise<LlmCallResult> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.config.headers
    };
    if (this.config.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const requestInit: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model,
        role: input.role,
        prompt_id: input.promptId,
        system: input.system,
        developer: input.developer,
        user: input.user,
        metadata: input.metadata ?? {}
      })
    };
    if (input.signal !== undefined) {
      requestInit.signal = input.signal;
    }
    const response = await fetchImpl(this.config.baseUrl, requestInit);
    if (!response.ok) {
      throw new Error(`GatewayProvider ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as { output_text?: string; rawText?: string; text?: string; model?: string };
    const rawText = payload.output_text ?? payload.rawText ?? payload.text;
    if (rawText === undefined) {
      throw new Error("GatewayProvider response missing output text");
    }
    return {
      providerId: this.providerId,
      model: payload.model ?? input.model,
      rawText
    };
  }
}

export class OpenAIProvider implements LlmProvider {
  readonly providerId: string;
  private readonly client: OpenAI;

  constructor(config: { apiKey?: string; providerId?: string; client?: OpenAI }) {
    this.providerId = config.providerId ?? "openai";
    this.client = config.client ?? new OpenAI({ apiKey: config.apiKey ?? process.env.OPENAI_API_KEY });
  }

  async completeJson(input: LlmCallInput): Promise<LlmCallResult> {
    const response = await this.client.responses.create(
      {
        model: input.model,
        input: [
          {
            role: "system",
            content: [input.system, input.developer].filter(Boolean).join("\n\n")
          },
          {
            role: "user",
            content: input.user
          }
        ]
      },
      { signal: input.signal }
    );
    const result: LlmCallResult = {
      providerId: this.providerId,
      model: input.model,
      rawText: response.output_text
    };
    if (response.usage !== undefined) {
      result.usage = response.usage as unknown as Record<string, unknown>;
    }
    return result;
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly providerId: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(config: { apiKey?: string; providerId?: string; client?: Anthropic; maxTokens?: number }) {
    this.providerId = config.providerId ?? "anthropic";
    this.client = config.client ?? new Anthropic({ apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.maxTokens = config.maxTokens ?? 4096;
  }

  async completeJson(input: LlmCallInput): Promise<LlmCallResult> {
    const message = await this.client.messages.create(
      {
        model: input.model,
        max_tokens: this.maxTokens,
        system: [input.system, input.developer].filter(Boolean).join("\n\n"),
        messages: [
          {
            role: "user",
            content: input.user
          }
        ]
      },
      { signal: input.signal }
    );
    const result: LlmCallResult = {
      providerId: this.providerId,
      model: input.model,
      rawText: message.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n")
    };
    if (message.usage !== undefined) {
      result.usage = message.usage as unknown as Record<string, unknown>;
    }
    if (message.stop_reason !== null) {
      result.finishReason = message.stop_reason;
    }
    return result;
  }
}
