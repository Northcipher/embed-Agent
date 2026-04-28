import { type CancelRunInput, type CancelRunResponse, type GetEvidenceInput, type GetEvidenceResponse, type GetRunEventsInput, type GetRunEventsResponse, type GetRunResultInput, type GetRunResultResponse, type GetTargetCapabilitiesInput, type GetTargetCapabilitiesResponse, type InterveneRunInput, type InterveneRunResponse, type PublicErrorResponse, type RunStatusInput, type RunStatusResponse, type ValidateArtifactInput, type ValidateArtifactResponse } from "@artifact-validation/contracts";
export type RuntimeClientResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: PublicErrorResponse;
};
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type RuntimeHttpClientOptions = {
    baseUrl?: string;
    fetchFn?: FetchLike;
};
export declare class RuntimeHttpClient {
    private readonly baseUrl;
    private readonly fetchFn;
    constructor(options?: RuntimeHttpClientOptions);
    validateArtifact(input: ValidateArtifactInput): Promise<RuntimeClientResult<ValidateArtifactResponse>>;
    getRunStatus(input: RunStatusInput): Promise<RuntimeClientResult<RunStatusResponse>>;
    getRunEvents(input: GetRunEventsInput): Promise<RuntimeClientResult<GetRunEventsResponse>>;
    getEvidence(input: GetEvidenceInput): Promise<RuntimeClientResult<GetEvidenceResponse>>;
    getRunResult(input: GetRunResultInput): Promise<RuntimeClientResult<GetRunResultResponse>>;
    interveneRun(input: InterveneRunInput): Promise<RuntimeClientResult<InterveneRunResponse>>;
    cancelRun(input: CancelRunInput): Promise<RuntimeClientResult<CancelRunResponse>>;
    getTargetCapabilities(input: GetTargetCapabilitiesInput): Promise<RuntimeClientResult<GetTargetCapabilitiesResponse>>;
    private request;
    private url;
}
//# sourceMappingURL=index.d.ts.map