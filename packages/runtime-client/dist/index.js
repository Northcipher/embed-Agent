import { CancelRunResponseSchema, GetEvidenceResponseSchema, GetRunEventsResponseSchema, GetRunResultResponseSchema, GetTargetCapabilitiesResponseSchema, InterveneRunResponseSchema, PublicErrorResponseSchema, RunStatusResponseSchema, ValidateArtifactResponseSchema } from "@artifact-validation/contracts";
export class RuntimeHttpClient {
    baseUrl;
    fetchFn;
    constructor(options = {}) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.ARTIFACT_VALIDATION_RUNTIME_URL ?? "http://127.0.0.1:3456");
        this.fetchFn = options.fetchFn ?? globalThis.fetch;
    }
    validateArtifact(input) {
        return this.request(ValidateArtifactResponseSchema, {
            method: "POST",
            path: "/api/validate-artifact",
            body: input
        });
    }
    getRunStatus(input) {
        return this.request(RunStatusResponseSchema, {
            method: "GET",
            path: `/api/runs/${encodeURIComponent(input.run_id)}/status`
        });
    }
    getRunEvents(input) {
        return this.request(GetRunEventsResponseSchema, {
            method: "GET",
            path: `/api/runs/${encodeURIComponent(input.run_id)}/events`,
            query: {
                after_seq: input.after_seq,
                limit: input.limit
            }
        });
    }
    getEvidence(input) {
        const query = input.ref === undefined || input.ref === null ? undefined : { ref: input.ref };
        return this.request(GetEvidenceResponseSchema, {
            method: "GET",
            path: `/api/runs/${encodeURIComponent(input.run_id)}/evidence`,
            ...(query === undefined ? {} : { query })
        });
    }
    getRunResult(input) {
        return this.request(GetRunResultResponseSchema, {
            method: "GET",
            path: `/api/runs/${encodeURIComponent(input.run_id)}/result`
        });
    }
    interveneRun(input) {
        return this.request(InterveneRunResponseSchema, {
            method: "POST",
            path: `/api/runs/${encodeURIComponent(input.run_id)}/interventions`,
            body: input
        });
    }
    cancelRun(input) {
        return this.request(CancelRunResponseSchema, {
            method: "POST",
            path: `/api/runs/${encodeURIComponent(input.run_id)}/cancel`,
            body: input
        });
    }
    getTargetCapabilities(input) {
        return this.request(GetTargetCapabilitiesResponseSchema, {
            method: "GET",
            path: `/api/targets/${encodeURIComponent(input.target)}/capabilities`
        });
    }
    async request(schema, request) {
        let response;
        try {
            const init = {
                method: request.method
            };
            if (request.body !== undefined) {
                init.headers = { "content-type": "application/json" };
                init.body = JSON.stringify(request.body);
            }
            response = await this.fetchFn(this.url(request.path, request.query), init);
        }
        catch (error) {
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
    url(path, query) {
        const url = new URL(path, `${this.baseUrl}/`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return url;
    }
}
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "");
}
async function readJson(response) {
    const text = await response.text();
    if (text.trim().length === 0) {
        return {};
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
function formatZodIssues(error) {
    return error.issues.map(issue => `${issue.path.join(".") || "<root>"} ${issue.message}`).join("; ");
}
//# sourceMappingURL=index.js.map