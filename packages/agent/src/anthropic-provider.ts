import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./llm-call-manager.js";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async completeJson(prompt: string, systemPrompt: string): Promise<Record<string, unknown>> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
