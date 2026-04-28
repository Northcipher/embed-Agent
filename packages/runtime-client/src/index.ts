import {
  CancelRunResponseSchema,
  GetEvidenceResponseSchema,
  GetRunEventsResponseSchema,
  GetRunResultResponseSchema,
  GetTargetCapabilitiesResponseSchema,
  InterveneRunResponseSchema,
  PublicErrorResponseSchema,
  RunStatusResponseSchema,
  ValidateArtifactResponseSchema,
  WatchRunInputSchema,
  WatchRunResponseSchema,
  type CancelRunInput,
  type CancelRunResponse,
  type GetEvidenceInput,
  type GetEvidenceResponse,
  type GetRunEventsInput,
  type GetRunEventsResponse,
  type GetRunResultInput,
  type GetRunResultResponse,
  type GetTargetCapabilitiesInput,
  type GetTargetCapabilitiesResponse,
  type InterveneRunInput,
  type InterveneRunResponse,
  type PublicErrorResponse,
  type RunStatusInput,
  type RunStatusResponse,
  type ValidateArtifactInput,
  type ValidateArtifactResponse,
  type WatchRunInput,
  type WatchRunResponse
} from "@artifact-validation/contracts";
import type { ZodError, ZodType } from "zod";

export type RuntimeClientResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: PublicErrorResponse;
    };

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_WATCH_WAIT_SEC = 300;

export type RuntimeHttpClientOptions = {
  baseUrl?: string;
  fetchFn?: FetchLike;
  sleepFn?: (milliseconds: number) => Promise<void>;
  nowFn?: () => number;
  watchPollIntervalMs?: number;
};

export class RuntimeHttpClient {
  private readonly baseUrl: string;

  private readonly fetchFn: FetchLike;

  private readonly sleepFn: (milliseconds: number) => Promise<void>;

  private readonly nowFn: () => number;

  private readonly watchPollIntervalMs: number;

  constructor(options: RuntimeHttpClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.ARTIFACT_VALIDATION_RUNTIME_URL ?? "http://127.0.0.1:3456"
    );
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sleepFn = options.sleepFn ?? sleep;
    this.nowFn = options.nowFn ?? Date.now;
    this.watchPollIntervalMs = options.watchPollIntervalMs ?? 250;
  }

  validateArtifact(input: ValidateArtifactInput): Promise<RuntimeClientResult<ValidateArtifactResponse>> {
    return this.request(ValidateArtifactResponseSchema, {
      method: "POST",
      path: "/api/validate-artifact",
      body: input
    });
  }

  getRunStatus(input: RunStatusInput): Promise<RuntimeClientResult<RunStatusResponse>> {
    return this.request(RunStatusResponseSchema, {
      method: "GET",
      path: `/api/runs/${encodeURIComponent(input.run_id)}/status`
    });
  }

  getRunEvents(input: GetRunEventsInput): Promise<RuntimeClientResult<GetRunEventsResponse>> {
    return this.request(GetRunEventsResponseSchema, {
      method: "GET",
      path: `/api/runs/${encodeURIComponent(input.run_id)}/events`,
      query: {
        after_seq: input.after_seq,
        limit: input.limit,
        types: input.types?.join(",")
      }
    });
  }

  async watchRun(input: WatchRunInput): Promise<RuntimeClientResult<WatchRunResponse>> {
    const parsed = WatchRunInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidClientRequest(`watch_run input is invalid: ${formatZodIssues(parsed.error)}`);
    }
    if (parsed.data.wait_sec > MAX_WATCH_WAIT_SEC) {
      return invalidClientRequest(`watch_run wait_sec must be <= ${MAX_WATCH_WAIT_SEC}`);
    }

    const request = parsed.data;
    const deadline = this.nowFn() + request.wait_sec * 1000;
    let lastResponse: WatchRunResponse | undefined;

    for (;;) {
      if (lastResponse !== undefined && this.nowFn() >= deadline) {
        return {
          ok: true,
          data: lastResponse
        };
      }

      const events = await this.getRunEvents({
        run_id: request.run_id,
        after_seq: request.after_seq,
        limit: request.limit,
        ...(request.types === undefined ? {} : { types: request.types })
      });
      if (!events.ok) {
        return events;
      }
      const status = await this.getRunStatus({ run_id: request.run_id });
      if (!status.ok) {
        return status;
      }

      const response = WatchRunResponseSchema.parse({
        run_id: request.run_id,
        status: status.data.status,
        events: events.data.events,
        next_after_seq: events.data.next_after_seq
      });
      lastResponse = response;
      if (response.events.length > 0 || request.wait_sec === 0 || isTerminalRunStatus(response.status) || this.nowFn() >= deadline) {
        return {
          ok: true,
          data: response
        };
      }

      await this.sleepFn(Math.min(this.watchPollIntervalMs, Math.max(0, deadline - this.nowFn())));
    }
  }

  getEvidence(input: GetEvidenceInput): Promise<RuntimeClientResult<GetEvidenceResponse>> {
    const query = input.ref === undefined || input.ref === null ? undefined : { ref: input.ref };
    return this.request(GetEvidenceResponseSchema, {
      method: "GET",
      path: `/api/runs/${encodeURIComponent(input.run_id)}/evidence`,
      ...(query === undefined ? {} : { query })
    });
  }

  getRunResult(input: GetRunResultInput): Promise<RuntimeClientResult<GetRunResultResponse>> {
    return this.request(GetRunResultResponseSchema, {
      method: "GET",
      path: `/api/runs/${encodeURIComponent(input.run_id)}/result`
    });
  }

  interveneRun(input: InterveneRunInput): Promise<RuntimeClientResult<InterveneRunResponse>> {
    return this.request(InterveneRunResponseSchema, {
      method: "POST",
      path: `/api/runs/${encodeURIComponent(input.run_id)}/interventions`,
      body: input
    });
  }

  cancelRun(input: CancelRunInput): Promise<RuntimeClientResult<CancelRunResponse>> {
    return this.request(CancelRunResponseSchema, {
      method: "POST",
      path: `/api/runs/${encodeURIComponent(input.run_id)}/cancel`,
      body: input
    });
  }

  getTargetCapabilities(
    input: GetTargetCapabilitiesInput
  ): Promise<RuntimeClientResult<GetTargetCapabilitiesResponse>> {
    return this.request(GetTargetCapabilitiesResponseSchema, {
      method: "GET",
      path: `/api/targets/${encodeURIComponent(input.target)}/capabilities`
    });
  }

  private async request<T>(
    schema: ZodType<T>,
    request: {
      method: "GET" | "POST";
      path: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    }
  ): Promise<RuntimeClientResult<T>> {
    let response: Response;
    try {
      const init: RequestInit = {
        method: request.method
      };
      if (request.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(request.body);
      }
      response = await this.fetchFn(this.url(request.path, request.query), init);
    } catch (error) {
      return {
        ok: false,
        error: {
          status: "error",
          error_code: "internal_error",
          message: error instanceof Error ? `Runtime API request failed: ${error.message}` : "Runtime API request failed"
        }
      };
    }

    const body = await readJson(response);
    if (!response.ok) {
      const parsedError = PublicErrorResponseSchema.safeParse(body);
      return {
        ok: false,
        error: parsedError.success
          ? parsedError.data
          : {
              status: "error",
              error_code: "internal_error",
              message: `Runtime API returned HTTP ${response.status}`
            }
      };
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          status: "error",
          error_code: "internal_error",
          message: `Runtime API response did not match contract: ${formatZodIssues(parsed.error)}`
        }
      };
    }
    return {
      ok: true,
      data: parsed.data
    };
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined>): URL {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isTerminalRunStatus(status: WatchRunResponse["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function invalidClientRequest<T>(message: string): RuntimeClientResult<T> {
  return {
    ok: false,
    error: {
      status: "error",
      error_code: "invalid_request",
      message
    }
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function formatZodIssues(error: ZodError): string {
  return error.issues.map(issue => `${issue.path.join(".") || "<root>"} ${issue.message}`).join("; ");
}
