import type { CapabilityName } from "@artifact-validation/contracts";
import type { CapabilityAdapter, CapabilityAdapterRegistry, CapabilityExecutionContext, CapabilityExecutionResult, CommandRunner } from "./types.js";
export type AdbAdapterConfig = {
    deviceId: string;
    adbPath?: string;
    runner?: CommandRunner;
    waitPollIntervalMs?: number;
    allowShellMetacharacters?: boolean;
};
export type FastbootFlashConfig = {
    method: "fastboot";
    partition: string;
    artifactType?: string;
    deviceId?: string;
    fastbootPath?: string;
    runner?: CommandRunner;
};
export type CustomFlashConfig = {
    method: "custom_command";
    command: {
        file: string;
        args: string[];
    };
    artifactType?: string;
    runner?: CommandRunner;
};
export type FlashAdapterConfig = FastbootFlashConfig | CustomFlashConfig;
export type SerialReadOptions = {
    port: string;
    baudRate: number;
    durationSec: number;
};
export interface SerialReader {
    read(options: SerialReadOptions): Promise<{
        content: string;
        disconnected: boolean;
        error?: string;
    }>;
}
export type SerialAdapterConfig = {
    port: string;
    baudRate: number;
    reader?: SerialReader;
};
export type RealAdapterRegistryConfig = {
    adb?: AdbAdapterConfig;
    flash?: FlashAdapterConfig;
    serial?: SerialAdapterConfig;
};
export declare class AdbAdapter implements CapabilityAdapter {
    readonly capability: CapabilityName;
    private readonly config;
    private readonly runner;
    constructor(capability: CapabilityName, config: AdbAdapterConfig);
    execute(context: CapabilityExecutionContext): Promise<CapabilityExecutionResult>;
    private executePush;
    private executeWaitAdb;
    private executeShellExec;
    private executeCheckProcess;
    private executeCollectLogs;
    private collectLog;
    private runAdb;
}
export declare class FlashAdapter implements CapabilityAdapter {
    private readonly config;
    readonly capability: "flash";
    private readonly runner;
    constructor(config: FlashAdapterConfig);
    execute(context: CapabilityExecutionContext): Promise<CapabilityExecutionResult>;
}
export declare class SerialAdapter implements CapabilityAdapter {
    private readonly config;
    readonly capability: "watch_serial";
    private readonly reader;
    constructor(config: SerialAdapterConfig);
    execute(context: CapabilityExecutionContext): Promise<CapabilityExecutionResult>;
}
export declare class SerialPortReader implements SerialReader {
    read(options: SerialReadOptions): Promise<{
        content: string;
        disconnected: boolean;
        error?: string;
    }>;
}
export declare class RealAdapterRegistry implements CapabilityAdapterRegistry {
    private readonly adapters;
    constructor(config: RealAdapterRegistryConfig);
    get(capability: CapabilityName): CapabilityAdapter | undefined;
}
//# sourceMappingURL=real-adapters.d.ts.map