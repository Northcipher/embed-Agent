/**
 * Unified Agent v2 — shared LLM call infrastructure for Planner / Observer / Reply.
 *
 * Two output paths:
 *   Primary:  Tool calling — model calls a "submit" tool, args are extracted directly.
 *             Uses AI SDK v6 API: stopWhen/isStepCount, inputSchema.
 *   Fallback: Text output — model returns free text, parsed via config.parse().
 *
 * Handles: message building → LLM call (tool or text) → CB4 → parse/fallback → audit.
 */
import { stepCountIs, type ToolSet } from "ai";
import type { LLMCallManager, LLMMessage } from "./llm.js";
import type { z } from "zod/v4";

export interface AgentConfig<TOutput> {
  /** Parse and validate LLM text output. Used in fallback (non-tool) path. */
  parse(content: string): TOutput;
  /** Generate fallback output when LLM fails or is degraded. */
  fallback(reason: string): TOutput;
  /** AI SDK tools for tool-calling. Undefined = no tools, single LLM text call. */
  tools?: ToolSet;
  /**
   * Output tool configuration for the primary (tool) path.
   * When set, the agent merges this tool into `tools` and extracts
   * output directly from the tool call args after generation.
   */
  outputTool?: {
    name: string;
    schema: z.ZodObject<z.ZodRawShape>;
    handler: (args: Record<string, unknown>) => TOutput;
  };
  /** Max tool-calling rounds. Default 2 when tools enabled, 1 otherwise. */
  stepCount?: number;
  /**
   * Prepend to user message in text fallback path.
   * Used to inject JSON format instructions when tool calling fails.
   */
  textFallbackPrefix?: string;
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

  async run(systemPrompt: string, formattedContext: string, runId?: string): Promise<TOutput> {
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: formattedContext },
    ];

    const inputChars = systemPrompt.length + formattedContext.length;
    let outputChars = 0;
    let tokenUsage: { input_tokens?: number; output_tokens?: number } | undefined;
    let cacheMetrics: { cacheCreationTokens: number; cacheReadTokens: number; totalInputTokens: number } | undefined;
    let degraded = false;
    let source = "llm";
    let result: TOutput;
    let rawContent = "";

    const mergedTools = this.buildTools();
    const useToolPath = this.config.outputTool != null && mergedTools != null;
    const stepCount = useToolPath ? (this.config.stepCount ?? 2) : 1;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = {};
      if (useToolPath) opts.stopWhen = stepCountIs(stepCount);
      if (mergedTools) opts.tools = mergedTools;

      const llmResult = await this.llm.call(this.role, messages, opts);

      if ("status" in llmResult) {
        result = this.config.fallback("LLM degraded — CB4 active");
        degraded = true;
        source = "fallback_cb4";
      } else {
        outputChars = llmResult.content.length;
        tokenUsage = llmResult.usage;
        cacheMetrics = llmResult.cacheMetrics;
        rawContent = llmResult.content;

        if (useToolPath && llmResult.toolResults) {
          const extracted = this.extractFromToolCall(llmResult.toolResults);
          if (extracted !== null) {
            result = extracted;
            source = "llm_tool";
          } else {
            result = this.config.parse(llmResult.content);
            source = "llm_text";
          }
        } else {
          result = this.config.parse(llmResult.content);
          source = "llm_text";
        }
      }
    } catch (e) {
      // Auto-degrade: if tools failed, retry without tools, bypassing CB4
      if (useToolPath && stepCount > 1) {
        try {
          // Prepend JSON format hint to user message for text-only fallback
          const fallbackMessages: LLMMessage[] = this.config.textFallbackPrefix
            ? [{ role: "system" as const, content: this.config.textFallbackPrefix + "\n\n" + messages[0]!.content }, { role: "user" as const, content: messages[1]!.content }]
            : messages;
          const retryResult = await this.llm.callBypassBreaker(this.role, fallbackMessages);
          if (!("status" in retryResult)) {
            outputChars = retryResult.content.length;
            tokenUsage = retryResult.usage;
            cacheMetrics = retryResult.cacheMetrics;
            rawContent = retryResult.content;
            result = this.config.parse(retryResult.content);
            source = "llm_text_fallback";
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

    const fallback = source !== "llm" && source !== "llm_tool" && source !== "llm_text" && source !== "llm_text_fallback";
    this.eb?.emit({
      type: "llm_call", run_id: runId, source: this.role,
      summary: `${this.role}: ${inputChars}→${outputChars} chars (${source})${degraded ? " degraded" : ""}`,
      payload: {
        role: this.role, input_chars: inputChars, output_chars: outputChars,
        token_input: tokenUsage?.input_tokens, token_output: tokenUsage?.output_tokens,
        degraded, fallback, source,
        cache_create: cacheMetrics?.cacheCreationTokens,
        cache_read: cacheMetrics?.cacheReadTokens,
        cache_hit_rate: cacheMetrics && cacheMetrics.totalInputTokens > 0
          ? Math.round((cacheMetrics.cacheReadTokens / cacheMetrics.totalInputTokens) * 100) / 100
          : undefined,
        raw_content: rawContent.slice(0, 3000),
        ...(source === "fallback_error" ? { error: "LLM call failed" } : {}),
      },
    });

    return result;
  }

  private buildTools(): ToolSet | null {
    const tools: Record<string, unknown> = {};

    if (this.config.tools) {
      Object.assign(tools, this.config.tools);
    }

    if (this.config.outputTool) {
      const ot = this.config.outputTool;
      tools[ot.name] = {
        description: `${ot.schema.description ?? ""}`.trim() || `Submit the ${ot.name} output`,
        inputSchema: ot.schema,
        execute: async (args: Record<string, unknown>) => args,
      };
    }

    return Object.keys(tools).length > 0 ? (tools as unknown as ToolSet) : null;
  }

  private extractFromToolCall(toolResults: unknown): TOutput | null {
    if (!this.config.outputTool) return null;

    const results = toolResults as Array<{
      toolName?: string;
      toolCallId?: string;
      args?: unknown;
      result?: unknown;
    }> | undefined;

    if (!results || !Array.isArray(results)) return null;

    for (const tr of results) {
      const toolName = tr.toolName;
      if (toolName !== this.config.outputTool.name) continue;

      const rawArgs = tr.args ?? (tr as Record<string, unknown>).input;
      if (rawArgs && typeof rawArgs === "object") {
        return this.config.outputTool.handler(rawArgs as Record<string, unknown>);
      }

      const res = tr.result;
      if (res && typeof res === "object") {
        return this.config.outputTool.handler(res as Record<string, unknown>);
      }
    }

    return null;
  }
}
