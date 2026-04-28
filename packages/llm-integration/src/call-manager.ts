import { parseSingleJsonObject } from "./parser.js";
import type { LlmCallInput, LlmCallResult, LlmProvider, ParseResult } from "./types.js";

export type ManagedLlmCallResult = {
  status: "parsed" | "parse_failed" | "timeout" | "provider_error";
  provider_result?: LlmCallResult;
  parse_result?: ParseResult;
  error?: string;
};

export class LlmCallManager {
  constructor(private readonly provider: LlmProvider) {}

  async completeAndParse(input: LlmCallInput): Promise<ManagedLlmCallResult> {
    const timeoutController = new AbortController();
    const combinedController = new AbortController();
    const abortFromTimeout = () => combinedController.abort(timeoutController.signal.reason);
    const abortFromCaller = () => combinedController.abort(input.signal?.reason);
    timeoutController.signal.addEventListener("abort", abortFromTimeout, { once: true });
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal?.aborted === true) {
      combinedController.abort(input.signal.reason);
    }
    const timeout = setTimeout(() => {
      timeoutController.abort();
    }, Math.max(0, input.timeoutSec) * 1000);

    try {
      const providerResult = await this.provider.completeJson({
        ...input,
        signal: combinedController.signal
      });
      const parseResult = parseSingleJsonObject(providerResult.rawText);
      if (parseResult.status === "parse_failed") {
        return {
          status: "parse_failed",
          provider_result: providerResult,
          parse_result: parseResult,
          error: parseResult.error
        };
      }
      return {
        status: "parsed",
        provider_result: providerResult,
        parse_result: parseResult
      };
    } catch (error) {
      const isTimeout = timeoutController.signal.aborted;
      return {
        status: isTimeout ? "timeout" : "provider_error",
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timeout);
      timeoutController.signal.removeEventListener("abort", abortFromTimeout);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
