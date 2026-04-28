import fastify, { type FastifyInstance } from "fastify";
import {
  CancelRunInputSchema,
  GetEvidenceInputSchema,
  GetRunEventsInputSchema,
  InterveneRunInputSchema,
  ValidateArtifactInputSchema,
  type PublicErrorResponse
} from "@artifact-validation/contracts";
import { z, type ZodType } from "zod";
import { invalidRequest, RuntimeHttpError } from "./errors.js";
import { RuntimeService, type RuntimeServiceOptions } from "./service.js";

export type RuntimeServerOptions = RuntimeServiceOptions & {
  logger?: boolean;
};

export type RuntimeServer = {
  app: FastifyInstance;
  service: RuntimeService;
};

export function buildRuntimeServer(options: RuntimeServerOptions): RuntimeServer {
  const app = fastify({ logger: options.logger ?? false });
  const service = new RuntimeService(options);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeHttpError) {
      reply.code(error.statusCode).send(error.response);
      return;
    }
    reply
      .code(500)
      .send(publicError("invalid_request", error instanceof Error ? error.message : "internal runtime server error"));
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(publicError("unsupported_action", "route not found"));
  });

  app.post("/api/validate-artifact", async request => {
    const input = parseWithSchema(ValidateArtifactInputSchema, request.body, "validate_artifact request");
    return service.validateArtifact(input);
  });

  app.get("/api/runs/:run_id/status", async request => {
    return service.getRunStatus(runIdParam(request.params));
  });

  app.get("/api/runs/:run_id/events", async request => {
    const runId = runIdParam(request.params);
    const query = request.query as Record<string, unknown>;
    const input = parseWithSchema(
      GetRunEventsInputSchema,
      {
        run_id: runId,
        after_seq: numberQuery(query.after_seq, 0),
        limit: numberQuery(query.limit, 100)
      },
      "get_run_events query"
    );
    return service.getRunEvents(runId, {
      afterSeq: input.after_seq,
      limit: input.limit
    });
  });

  app.get("/api/runs/:run_id/evidence", async request => {
    const runId = runIdParam(request.params);
    const query = request.query as Record<string, unknown>;
    const input = parseWithSchema(
      GetEvidenceInputSchema,
      {
        run_id: runId,
        ref: optionalStringQuery(query.ref)
      },
      "get_evidence query"
    );
    return service.getEvidence(runId, input.ref ?? undefined);
  });

  app.get("/api/runs/:run_id/result", async request => {
    return service.getRunResult(runIdParam(request.params));
  });

  app.post("/api/runs/:run_id/interventions", async request => {
    const runId = runIdParam(request.params);
    const body = objectBody(request.body);
    const input = parseWithSchema(
      InterveneRunInputSchema,
      {
        ...body,
        run_id: runId
      },
      "intervene_run request"
    );
    return service.interveneRun(input);
  });

  app.post("/api/runs/:run_id/cancel", async request => {
    const runId = runIdParam(request.params);
    const body = objectBody(request.body);
    const input = parseWithSchema(
      CancelRunInputSchema,
      {
        ...body,
        run_id: runId
      },
      "cancel_run request"
    );
    return service.cancelRun(runId, input.reason);
  });

  app.get("/api/targets/:target_id/capabilities", async request => {
    return service.getTargetCapabilities(targetIdParam(request.params));
  });

  return { app, service };
}

function parseWithSchema<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidRequest(`${label} is invalid: ${parsed.error.issues.map(issue => issue.message).join("; ")}`);
  }
  return parsed.data;
}

function runIdParam(params: unknown): string {
  const parsed = z.object({ run_id: z.string().min(1) }).safeParse(params);
  if (!parsed.success) {
    throw invalidRequest("run_id parameter is required");
  }
  return parsed.data.run_id;
}

function targetIdParam(params: unknown): string {
  const parsed = z.object({ target_id: z.string().min(1) }).safeParse(params);
  if (!parsed.success) {
    throw invalidRequest("target_id parameter is required");
  }
  return parsed.data.target_id;
}

function numberQuery(value: unknown, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }
  return Number.NaN;
}

function optionalStringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw invalidRequest("request body must be an object");
}

function publicError(error_code: PublicErrorResponse["error_code"], message: string): PublicErrorResponse {
  return {
    status: "error",
    error_code,
    message
  };
}
