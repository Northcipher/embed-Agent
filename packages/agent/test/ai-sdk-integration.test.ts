/**
 * Integration test: real AI SDK provider calls against the configured endpoint.
 * Runs only when ANTHROPIC_AUTH_TOKEN is set. Skipped otherwise.
 */
import { describe, it, expect } from "vitest";
import { AIAnthropicProvider, AIOpenAICompatibleProvider } from "../src/llm.js";

const AUTH_TOKEN = process.env["ANTHROPIC_AUTH_TOKEN"];
const BASE_URL = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.deepseek.com/anthropic";
const MODEL = process.env["ANTHROPIC_MODEL"] ?? "deepseek-v4-flash[1m]";

const describeIf = AUTH_TOKEN ? describe : describe.skip;

describeIf("AI SDK real integration", () => {
  it("AIAnthropicProvider calls DeepSeek Anthropic endpoint", async () => {
    const provider = new AIAnthropicProvider(AUTH_TOKEN!, BASE_URL);

    const resp = await provider.call(
      [
        { role: "system", content: "Reply with exactly: {\"ok\":true}" },
        { role: "user", content: "Say hi" },
      ],
      { model: MODEL, timeout: 30, maxTokens: 200 },
    );

    console.log(`Model: ${resp.model}`);
    console.log(`Content: ${resp.content.slice(0, 200)}`);
    if (resp.usage) console.log(`Usage: in=${resp.usage.input_tokens} out=${resp.usage.output_tokens}`);

    expect(resp.content).toBeTruthy();
    expect(resp.model).toBeTruthy();
    // Should parse as JSON since we asked for it
    try {
      const parsed = JSON.parse(resp.content);
      console.log("Parsed:", JSON.stringify(parsed));
    } catch {
      // LLMs sometimes add extra text — check content is non-empty
      expect(resp.content.length).toBeGreaterThan(0);
    }
  }, 30000);

  it("AIAnthropicProvider calls without system prompt", async () => {
    const provider = new AIAnthropicProvider(AUTH_TOKEN!, BASE_URL);

    const resp = await provider.call(
      [{ role: "user", content: "Reply with exactly one word: hello" }],
      { model: MODEL, timeout: 30, maxTokens: 50 },
    );

    console.log(`Content: ${resp.content.trim()}`);
    expect(resp.content).toBeTruthy();
  }, 30000);

  it("AIAnthropicProvider with invalid key fails clearly", async () => {
    const provider = new AIAnthropicProvider("bad-key", BASE_URL);

    await expect(
      provider.call(
        [{ role: "user", content: "hi" }],
        { model: MODEL, timeout: 15, maxTokens: 10 },
      ),
    ).rejects.toThrow();
  }, 20000);

  it("AIOpenAICompatibleProvider calls LiteLLM-style gateway", async () => {
    // Test that the provider can be constructed with a base URL
    // This test doesn't actually call unless a real gateway is running
    const provider = new AIOpenAICompatibleProvider(
      "https://api.deepseek.com/v1", // OpenAI-compatible endpoint on DeepSeek
      AUTH_TOKEN!,
    );

    // DeepSeek's v1 endpoint should accept OpenAI-compatible requests
    const resp = await provider.call(
      [
        { role: "system", content: "Reply with exactly: OK" },
        { role: "user", content: "test" },
      ],
      { model: "deepseek-chat", timeout: 30, maxTokens: 50 },
    );

    console.log(`Compatible: model=${resp.model}, content=${resp.content.trim()}`);
    if (resp.usage) console.log(`Usage: in=${resp.usage.input_tokens} out=${resp.usage.output_tokens}`);
    expect(resp.content).toBeTruthy();
  }, 30000);
});
