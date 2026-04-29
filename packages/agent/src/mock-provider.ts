import type { LlmProvider } from "./llm-call-manager.js";

export class MockProvider implements LlmProvider {
  private responses: Map<string, Record<string, unknown>> = new Map();

  setResponse(promptKey: string, response: Record<string, unknown>): void {
    this.responses.set(promptKey, response);
  }

  async completeJson(_prompt: string, _systemPrompt: string): Promise<Record<string, unknown>> {
    return this.responses.get("default") ?? { status: "ok" };
  }
}
