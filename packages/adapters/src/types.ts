import type { CapabilityName, PlanStep } from "@artifact-validation/contracts";
import type { FileStore } from "@artifact-validation/file-store";

export type CapabilityExecutionContext = {
  runId: string;
  step: PlanStep;
  store: FileStore;
};

export type CapabilityExecutionResult = {
  capability: CapabilityName;
  success: boolean;
  status: "completed" | "failed" | "timeout";
  output: Record<string, unknown>;
  evidence_refs: string[];
  summary: string;
};

export interface CapabilityAdapter {
  readonly capability: CapabilityName;
  execute(context: CapabilityExecutionContext): Promise<CapabilityExecutionResult>;
}

export type CapabilityAdapterRegistry = {
  get(capability: CapabilityName): CapabilityAdapter | undefined;
};

export type CommandInvocation = {
  file: string;
  args: string[];
  timeoutSec: number;
  stdin?: string;
};

export type CommandRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationSec: number;
};

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandRunResult>;
}
