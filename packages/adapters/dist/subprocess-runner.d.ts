import type { CommandInvocation, CommandRunner, CommandRunResult } from "./types.js";
export declare class SpawnCommandRunner implements CommandRunner {
    private readonly maxOutputBytes;
    constructor(options?: {
        maxOutputBytes?: number;
    });
    run(invocation: CommandInvocation): Promise<CommandRunResult>;
}
//# sourceMappingURL=subprocess-runner.d.ts.map