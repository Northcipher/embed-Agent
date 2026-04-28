import type { CapabilityName } from "@artifact-validation/contracts";
import type { CapabilityAdapter, CapabilityAdapterRegistry, CapabilityExecutionContext, CapabilityExecutionResult } from "./types.js";
type CommandResult = {
    exit_code: number;
    stdout?: string;
    stderr?: string;
};
export type FakeTargetScript = {
    adbOnline?: boolean;
    flashSucceeds?: boolean;
    serialOutput?: string[];
    commandResults?: Record<string, CommandResult>;
    processes?: Record<string, {
        pid: number;
        state: string;
    }>;
    logs?: Record<string, string>;
};
export declare class FakeCapabilityAdapter implements CapabilityAdapter {
    readonly capability: CapabilityName;
    private readonly script;
    constructor(capability: CapabilityName, script?: FakeTargetScript);
    execute(context: CapabilityExecutionContext): Promise<CapabilityExecutionResult>;
    private executeFlash;
    private executePush;
    private executeWatchSerial;
    private executeWaitAdb;
    private executeShellExec;
    private executeCheckProcess;
    private executeCollectLogs;
    private executeSaveSnapshot;
}
export declare class FakeAdapterRegistry implements CapabilityAdapterRegistry {
    private readonly adapters;
    constructor(script?: FakeTargetScript);
    get(capability: CapabilityName): CapabilityAdapter | undefined;
}
export {};
//# sourceMappingURL=fake-adapter.d.ts.map