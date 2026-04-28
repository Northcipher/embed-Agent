#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import {
  InterveneRunInputSchema,
  ValidateArtifactInputSchema,
  WatchRunInputSchema,
  type CancelRunInput,
  type GetEvidenceInput,
  type GetRunEventsInput,
  type GetRunResultInput,
  type GetTargetCapabilitiesInput,
  type InterveneRunInput,
  type PublicErrorResponse,
  type RunStatusInput,
  type WatchRunInput,
  type WatchRunResponse
} from "@artifact-validation/contracts";
import { RuntimeHttpClient, type RuntimeClientResult } from "@artifact-validation/runtime-client";

export type CliRuntimeClient = Pick<
  RuntimeHttpClient,
  | "validateArtifact"
  | "getRunStatus"
  | "getRunEvents"
  | "getEvidence"
  | "getRunResult"
  | "interveneRun"
  | "cancelRun"
  | "getTargetCapabilities"
>;

export type CliIo = {
  readFile(path: string): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  setExitCode(code: number): void;
};

export type CreateCliProgramOptions = {
  client?: CliRuntimeClient;
  clientFactory?: (runtimeUrl?: string) => CliRuntimeClient;
  io?: Partial<CliIo>;
};

export function createCliProgram(options: CreateCliProgramOptions = {}): Command {
  const io = createIo(options.io);
  const program = new Command();

  const clientForCommand = (): CliRuntimeClient => {
    if (options.client !== undefined) {
      return options.client;
    }
    const runtimeUrl = program.opts<{ runtimeUrl?: string }>().runtimeUrl;
    return options.clientFactory?.(runtimeUrl) ?? new RuntimeHttpClient(runtimeUrl === undefined ? {} : { baseUrl: runtimeUrl });
  };

  program
    .name("va")
    .description("Artifact Validation Agent CLI thin adapter")
    .option("--runtime-url <url>", "Runtime Server base URL; defaults to ARTIFACT_VALIDATION_RUNTIME_URL or localhost");

  program
    .command("validate")
    .description("Start artifact validation from a JSON request file")
    .requiredOption("--input <path>", "Path to validate_artifact JSON input")
    .action(async (commandOptions: { input: string }) => {
      const input = await readValidateInput(commandOptions.input, io);
      if (!input.ok) {
        writeJson(io, input.error, true);
        return;
      }
      await writeClientResult(io, await clientForCommand().validateArtifact(input.data));
    });

  program
    .command("status")
    .description("Read current run status")
    .argument("<run_id>", "Run id")
    .action(async (runId: string) => {
      await writeClientResult(io, await clientForCommand().getRunStatus({ run_id: runId } satisfies RunStatusInput));
    });

  program
    .command("watch")
    .description("Read run status plus event stream entries after a sequence cursor")
    .argument("<run_id>", "Run id")
    .option("--after-seq <seq>", "Return events after this sequence", parseNonNegativeInteger, 0)
    .option("--limit <count>", "Maximum events to return", parsePositiveInteger, 50)
    .action(async (runId: string, commandOptions: { afterSeq: number; limit: number }) => {
      await writeClientResult(
        io,
        await watchRun(clientForCommand(), {
          run_id: runId,
          after_seq: commandOptions.afterSeq,
          limit: commandOptions.limit,
          wait_sec: 0
        })
      );
    });

  program
    .command("events")
    .description("Read historical run events")
    .argument("<run_id>", "Run id")
    .option("--after-seq <seq>", "Return events after this sequence", parseNonNegativeInteger, 0)
    .option("--limit <count>", "Maximum events to return", parsePositiveInteger, 100)
    .action(async (runId: string, commandOptions: { afterSeq: number; limit: number }) => {
      await writeClientResult(
        io,
        await clientForCommand().getRunEvents({
          run_id: runId,
          after_seq: commandOptions.afterSeq,
          limit: commandOptions.limit
        } satisfies GetRunEventsInput)
      );
    });

  program
    .command("evidence")
    .description("Read evidence index or one evidence reference")
    .argument("<run_id>", "Run id")
    .option("--ref <ref>", "Evidence ref")
    .action(async (runId: string, commandOptions: { ref?: string }) => {
      await writeClientResult(
        io,
        await clientForCommand().getEvidence({
          run_id: runId,
          ...(commandOptions.ref === undefined ? {} : { ref: commandOptions.ref })
        } satisfies GetEvidenceInput)
      );
    });

  program
    .command("result")
    .description("Read final or unavailable run result")
    .argument("<run_id>", "Run id")
    .action(async (runId: string) => {
      await writeClientResult(io, await clientForCommand().getRunResult({ run_id: runId } satisfies GetRunResultInput));
    });

  program
    .command("cancel")
    .description("Cancel a Runtime-owned run")
    .argument("<run_id>", "Run id")
    .option("--reason <text>", "Cancellation reason")
    .action(async (runId: string, commandOptions: { reason?: string }) => {
      await writeClientResult(
        io,
        await clientForCommand().cancelRun({
          run_id: runId,
          ...(commandOptions.reason === undefined ? {} : { reason: commandOptions.reason })
        } satisfies CancelRunInput)
      );
    });

  program
    .command("pause")
    .description("Request a pause intervention")
    .argument("<run_id>", "Run id")
    .option("--reason <text>", "Pause reason")
    .action(async (runId: string, commandOptions: { reason?: string }) => {
      await writeClientResult(io, await clientForCommand().interveneRun(intervention(runId, "pause", commandOptions)));
    });

  program
    .command("resume")
    .description("Request a resume intervention")
    .argument("<run_id>", "Run id")
    .option("--reason <text>", "Resume reason")
    .action(async (runId: string, commandOptions: { reason?: string }) => {
      await writeClientResult(io, await clientForCommand().interveneRun(intervention(runId, "resume", commandOptions)));
    });

  program
    .command("intervene")
    .description("Request an allowed Runtime intervention")
    .argument("<run_id>", "Run id")
    .requiredOption("--action <action>", "pause, resume, cancel, add_instruction, or request_partial_evidence")
    .option("--reason <text>", "Intervention reason")
    .option("--instruction <text>", "Instruction text for add_instruction")
    .action(
      async (
        runId: string,
        commandOptions: {
          action: InterveneRunInput["action"];
          reason?: string;
          instruction?: string;
        }
      ) => {
        const parsed = InterveneRunInputSchema.safeParse({
          run_id: runId,
          action: commandOptions.action,
          ...(commandOptions.reason === undefined ? {} : { reason: commandOptions.reason }),
          ...(commandOptions.instruction === undefined ? {} : { instruction: commandOptions.instruction })
        });
        if (!parsed.success) {
          writeJson(io, invalidRequest(`intervention input is invalid: ${formatIssues(parsed.error)}`), true);
          return;
        }
        await writeClientResult(io, await clientForCommand().interveneRun(parsed.data));
      }
    );

  program
    .command("capabilities")
    .description("Read Runtime-reported target capabilities")
    .argument("<target>", "Target id")
    .action(async (target: string) => {
      await writeClientResult(
        io,
        await clientForCommand().getTargetCapabilities({ target } satisfies GetTargetCapabilitiesInput)
      );
    });

  program.configureOutput({
    writeOut: text => io.writeStdout(text),
    writeErr: text => io.writeStderr(text)
  });

  return program;
}

async function watchRun(client: CliRuntimeClient, input: WatchRunInput): Promise<RuntimeClientResult<WatchRunResponse>> {
  const parsed = WatchRunInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: invalidRequest(`watch_run input is invalid: ${formatIssues(parsed.error)}`)
    };
  }
  const events = await client.getRunEvents({
    run_id: parsed.data.run_id,
    after_seq: parsed.data.after_seq,
    limit: parsed.data.limit
  });
  if (!events.ok) {
    return events;
  }
  const status = await client.getRunStatus({ run_id: parsed.data.run_id });
  if (!status.ok) {
    return status;
  }
  return {
    ok: true,
    data: {
      run_id: parsed.data.run_id,
      status: status.data.status,
      events: events.data.events,
      next_after_seq: events.data.next_after_seq
    }
  };
}

function intervention(
  runId: string,
  action: "pause" | "resume",
  commandOptions: { reason?: string }
): InterveneRunInput {
  return {
    run_id: runId,
    action,
    ...(commandOptions.reason === undefined ? {} : { reason: commandOptions.reason })
  };
}

async function readValidateInput(path: string, io: CliIo) {
  let raw: string;
  try {
    raw = await io.readFile(path);
  } catch (error) {
    return {
      ok: false as const,
      error: invalidRequest(error instanceof Error ? `failed to read input file: ${error.message}` : "failed to read input file")
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false as const,
      error: invalidRequest(error instanceof Error ? `input file is not valid JSON: ${error.message}` : "input file is not valid JSON")
    };
  }

  const parsed = ValidateArtifactInputSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: invalidRequest(`validate_artifact input is invalid: ${formatIssues(parsed.error)}`)
    };
  }
  return {
    ok: true as const,
    data: parsed.data
  };
}

async function writeClientResult<T>(io: CliIo, result: RuntimeClientResult<T>): Promise<void> {
  if (!result.ok) {
    writeJson(io, result.error, true);
    return;
  }
  writeJson(io, result.data);
}

function writeJson(io: CliIo, value: unknown, isError = false): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (isError) {
    io.writeStderr(text);
    io.setExitCode(1);
    return;
  }
  io.writeStdout(text);
}

function invalidRequest(message: string): PublicErrorResponse {
  return {
    status: "error",
    error_code: "invalid_request",
    message
  };
}

function parseNonNegativeInteger(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return Number(value);
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return Number(value);
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map(issue => `${issue.path.join(".") || "<root>"} ${issue.message}`).join("; ");
}

function createIo(overrides: Partial<CliIo> = {}): CliIo {
  return {
    readFile: overrides.readFile ?? (path => readFile(path, "utf8")),
    writeStdout: overrides.writeStdout ?? (text => process.stdout.write(text)),
    writeStderr: overrides.writeStderr ?? (text => process.stderr.write(text)),
    setExitCode: overrides.setExitCode ?? (code => {
      process.exitCode = code;
    })
  };
}

async function main(): Promise<void> {
  await createCliProgram().parseAsync(process.argv);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    process.stderr.write(`artifact-validation CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
