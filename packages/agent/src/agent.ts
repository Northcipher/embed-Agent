/**
 * Unified Agent — shared LLM call infrastructure for Planner / Observer / Reply.
 * Handles: message building → LLM call → CB4 degraded → JSON parse → fallback → audit.
 * Each role provides parse(), fallback(), and optionally tools via AgentConfig.
 */
import type { ToolSet } from "ai";
import type { LLMCallManager, LLMMessage } from "./llm.js";

export interface AgentConfig<TOutput> {
  /** Parse and validate LLM output. Called after successful LLM call. */
  parse(content: string): TOutput;
  /** Generate fallback output when LLM fails or is degraded. */
  fallback(reason: string): TOutput;
  /** AI SDK tools for tool-calling. Undefined = no tools, single LLM call. */
  tools?: ToolSet;
  /** Max tool-calling rounds (AI SDK maxSteps). Default 1 = no tools. */
  maxSteps?: number;
}

interface AgentEmitter {
  emit(e: Record<string, unknown>): Promise<void>;
}

export class Agent<TOutput> {
  constructor(
    private role: "planner" | "observer" | "reply",
    private llm: LLMCallManager,
    private config: AgentConfig<TOutput>,
    private eb?: AgentEmitter,
  ) {}

  /**
   * Execute one LLM run: systemPrompt + formattedContext → TOutput.
   * Handles degraded/error → fallback, success → parse.
   * Emits llm_call audit event on every call.
   */
  async run(systemPrompt: string, formattedContext: string, runId?: string): Promise<TOutput> {
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: formattedContext },
    ];

    const inputChars = systemPrompt.length + formattedContext.length;
    let outputChars = 0;
    let tokenUsage: { input_tokens?: number; output_tokens?: number } | undefined;
    let degraded = false;
    let source = "llm";

    let result: TOutput;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = { maxSteps: this.config.maxSteps ?? 1 };
      if (this.config.tools) opts.tools = this.config.tools;
      const llmResult = await this.llm.call(this.role, messages, opts);

      if ("status" in llmResult) {
        result = this.config.fallback("LLM degraded — CB4 active");
        degraded = true; source = "fallback_cb4";
      } else {
        outputChars = llmResult.content.length;
        tokenUsage = llmResult.usage;
        result = this.config.parse(llmResult.content);
      }
    } catch (e) {
      // Auto-degrade: if tools failed, retry without tools, bypassing CB4
      // (tools may be unsupported by the endpoint, which is not an LLM failure)
      if (this.config.tools && this.config.maxSteps && this.config.maxSteps > 1) {
        try {
          // Bypass CB4 — this is endpoint compatibility, not a real failure
          const retryResult = await this.llm.callBypassBreaker(this.role, messages, { maxSteps: 1 });
          if (!("status" in retryResult)) {
            outputChars = retryResult.content.length;
            tokenUsage = retryResult.usage;
            result = this.config.parse(retryResult.content);
            source = "llm"; // not a fallback — LLM succeeded without tools
            // fall through to audit emit
          } else {
            result = this.config.fallback("LLM degraded after tool fallback");
            source = "fallback_error";
          }
        } catch (e2) {
          result = this.config.fallback((e2 as Error).message);
          source = "fallback_error";
        }
      } else {
        result = this.config.fallback((e as Error).message);
        source = "fallback_error";
      }
    }

    // Emit llm_call audit event
    this.eb?.emit({
      type: "llm_call", run_id: runId, source: this.role,
      summary: `${this.role}: ${inputChars}→${outputChars} chars${degraded ? " (degraded)" : ""}${source !== "llm" ? ` (${source})` : ""}`,
      payload: {
        role: this.role, input_chars: inputChars, output_chars: outputChars,
        token_input: tokenUsage?.input_tokens, token_output: tokenUsage?.output_tokens,
        degraded, fallback: source !== "llm",
        ...(source === "fallback_error" ? { error: "LLM call failed" } : {}),
      },
    });

    return result;
  }
}
