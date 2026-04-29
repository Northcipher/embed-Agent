#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { FakeAdapterRegistry, RealAdapterRegistry, type CapabilityAdapterRegistry } from "@artifact-validation/adapters";
import type { Plan, PlanStep, TargetProfile, ValidateArtifactInput } from "@artifact-validation/contracts";
import {
  buildRuntimeServer,
  buildRuntimeServerWithLlmConfig,
  type RuntimeServer,
  type RuntimeServerOptions
} from "./server.js";
import { loadTargetProfilesFromDir } from "./target-profiles.js";

export type RuntimeServerCliOptions = {
  host: string;
  port: number;
  rootDir: string;
  targetsDir: string | undefined;
  adapter: "fake" | "real";
  llmConfigPath?: string;
  executePlansInline: boolean;
  demoPlan: boolean;
  logger: boolean;
};

export type StartedRuntimeServer = RuntimeServer & {
  address: string;
  close(): Promise<void>;
};

type RuntimeServerCliDeps = {
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export function parseRuntimeServerCliArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): RuntimeServerCliOptions {
  const options: RuntimeServerCliOptions = {
    host: env.ARTIFACT_VALIDATION_RUNTIME_HOST ?? "127.0.0.1",
    port: parsePort(env.ARTIFACT_VALIDATION_RUNTIME_PORT ?? "3456", "ARTIFACT_VALIDATION_RUNTIME_PORT"),
    rootDir: env.ARTIFACT_VALIDATION_ROOT_DIR ?? ".artifact-agent",
    targetsDir: env.ARTIFACT_VALIDATION_TARGETS_DIR ?? "configs/targets",
    adapter: env.ARTIFACT_VALIDATION_ADAPTER === "real" ? "real" : "fake",
    executePlansInline: env.ARTIFACT_VALIDATION_EXECUTE_INLINE === "1",
    demoPlan: env.ARTIFACT_VALIDATION_DEMO_PLAN === "1",
    logger: env.ARTIFACT_VALIDATION_LOG === "1"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--host":
        options.host = requiredValue(argv, ++index, arg);
        break;
      case "--port":
        options.port = parsePort(requiredValue(argv, ++index, arg), arg);
        break;
      case "--root-dir":
        options.rootDir = requiredValue(argv, ++index, arg);
        break;
      case "--targets-dir":
        options.targetsDir = requiredValue(argv, ++index, arg);
        break;
      case "--no-targets":
        options.targetsDir = undefined;
        break;
      case "--adapter": {
        const value = requiredValue(argv, ++index, arg);
        if (value !== "fake" && value !== "real") {
          throw new Error("--adapter must be fake or real");
        }
        options.adapter = value;
        break;
      }
      case "--llm-config":
        options.llmConfigPath = requiredValue(argv, ++index, arg);
        break;
      case "--execute-inline":
        options.executePlansInline = true;
        break;
      case "--demo-plan":
        options.demoPlan = true;
        break;
      case "--log":
        options.logger = true;
        break;
      case "--help":
      case "-h":
        throw new HelpRequestedError();
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  return options;
}

export async function createRuntimeServerFromCliOptions(
  options: RuntimeServerCliOptions,
  deps: RuntimeServerCliDeps = {}
): Promise<RuntimeServer> {
  const cwd = deps.cwd ?? process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir);
  const targetProfiles = await loadOptionalTargetProfiles(options.targetsDir, cwd);
  const adapters = createAdapters(options.adapter, targetProfiles);
  const baseOptions: RuntimeServerOptions = {
    rootDir,
    adapters,
    executePlansInline: options.executePlansInline,
    logger: options.logger,
    ...(targetProfiles === undefined ? {} : { targetProfiles }),
    ...(options.demoPlan ? { planFactory: demoPlanFromValidateInput } : {})
  };

  if (options.llmConfigPath !== undefined) {
    return buildRuntimeServerWithLlmConfig({
      ...baseOptions,
      llmConfigPath: path.resolve(cwd, options.llmConfigPath),
      llmEnv: deps.env ?? process.env
    });
  }
  return buildRuntimeServer(baseOptions);
}

export async function startRuntimeServer(
  options: RuntimeServerCliOptions,
  deps: RuntimeServerCliDeps = {}
): Promise<StartedRuntimeServer> {
  const runtime = await createRuntimeServerFromCliOptions(options, deps);
  const address = await runtime.app.listen({ host: options.host, port: options.port });
  return {
    ...runtime,
    address,
    close: () => runtime.app.close()
  };
}

export function demoPlanFromValidateInput(input: ValidateArtifactInput): Plan {
  const steps: PlanStep[] = [];
  const maxDurationSec = input.constraints.max_duration_sec;
  const watchDurationSec = Math.min(180, maxDurationSec);

  if (input.constraints.allow_flash === true) {
    steps.push({
      id: "step-flash",
      capability: "flash",
      condition: "always",
      input: {
        artifact_ref: input.artifact.path,
        artifact_type: input.artifact.type
      },
      timeout_sec: Math.min(300, maxDurationSec)
    });
  }

  steps.push(
    {
      id: "step-serial",
      capability: "watch_serial",
      condition: "always",
      input: {
        duration_sec: watchDurationSec,
        patterns: input.context.concerns ?? []
      },
      timeout_sec: watchDurationSec
    },
    {
      id: "step-adb",
      capability: "wait_adb",
      condition: "always",
      input: {
        timeout_sec: Math.min(180, maxDurationSec)
      },
      timeout_sec: Math.min(180, maxDurationSec)
    }
  );

  if (input.context.test_hint?.kind === "adb_shell") {
    steps.push({
      id: "step-smoke",
      capability: "shell_exec",
      condition: "always",
      input: {
        command: input.context.test_hint.command,
        expected_exit_code: input.context.test_hint.expected_exit_code ?? 0,
        timeout_sec: input.context.test_hint.timeout_sec ?? 60
      },
      timeout_sec: input.context.test_hint.timeout_sec ?? 60
    });
  }

  steps.push({
    id: "step-logs",
    capability: "collect_logs",
    condition: "on_success",
    input: {
      items: ["dmesg"]
    },
    timeout_sec: 60
  });

  return {
    plan_id: "plan-demo",
    estimated_duration_sec: maxDurationSec,
    steps,
    success_criteria: [input.context.expected],
    failure_signals: input.context.concerns ?? [],
    evidence_policy: {
      always: ["serial:full"],
      on_success: ["log:dmesg"],
      on_failure: ["serial:full", "log:dmesg"]
    }
  };
}

async function loadOptionalTargetProfiles(targetsDir: string | undefined, cwd: string): Promise<TargetProfile[] | undefined> {
  if (targetsDir === undefined) {
    return undefined;
  }
  const resolvedTargetsDir = path.resolve(cwd, targetsDir);
  try {
    return await loadTargetProfilesFromDir(resolvedTargetsDir);
  } catch (error) {
    throw new Error(
      `failed to load target profiles from ${resolvedTargetsDir}; pass --targets-dir <path> or --no-targets for fake local testing: ${safeErrorMessage(error)}`
    );
  }
}

function createAdapters(adapter: RuntimeServerCliOptions["adapter"], targetProfiles: TargetProfile[] | undefined): CapabilityAdapterRegistry {
  if (adapter === "fake") {
    return new FakeAdapterRegistry({
      serialOutput: ["Booting Linux", "init started", "boot completed"],
      commandResults: {
        "/vendor/bin/smoke_test": {
          exit_code: 0,
          stdout: "pass\n",
          stderr: ""
        }
      },
      logs: {
        dmesg: "clean dmesg\n"
      }
    });
  }

  const profile = onlyTargetProfile(targetProfiles);
  return new RealAdapterRegistry({
    ...(profile.connections.adb === undefined
      ? {}
      : {
          adb: {
            deviceId: profile.connections.adb.device_id
          }
        }),
    ...(profile.connections.serial === undefined
      ? {}
      : {
          serial: {
            port: profile.connections.serial.port,
            baudRate: profile.connections.serial.baud
          }
        }),
    ...(profile.flash === undefined ? {} : realFlashConfig(profile))
  });
}

function realFlashConfig(profile: TargetProfile) {
  if (profile.flash?.method === "fastboot" && profile.flash.partition !== undefined) {
    return {
      flash: {
        method: "fastboot" as const,
        partition: profile.flash.partition,
        ...(profile.flash.artifact_type === undefined ? {} : { artifactType: profile.flash.artifact_type })
      }
    };
  }
  if (profile.flash?.method === "custom_command" && profile.flash.command !== undefined) {
    return {
      flash: {
        method: "custom_command" as const,
        command: profile.flash.command,
        ...(profile.flash.artifact_type === undefined ? {} : { artifactType: profile.flash.artifact_type })
      }
    };
  }
  return {};
}

function onlyTargetProfile(targetProfiles: TargetProfile[] | undefined): TargetProfile {
  if (targetProfiles === undefined || targetProfiles.length === 0) {
    throw new Error("--adapter real requires exactly one target profile; pass --targets-dir <path> with one target JSON file");
  }
  if (targetProfiles.length > 1) {
    throw new Error("--adapter real currently supports exactly one target profile; split multi-target testing into separate runs");
  }
  const profile = targetProfiles[0];
  if (profile === undefined) {
    throw new Error("--adapter real requires exactly one target profile; pass --targets-dir <path> with one target JSON file");
  }
  return profile;
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} must be an integer port between 0 and 65535`);
  }
  return port;
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

class HelpRequestedError extends Error {
  constructor() {
    super("help requested");
  }
}

function usage(): string {
  return [
    "Usage: artifact-validation-runtime [options]",
    "",
    "Options:",
    "  --host <host>          Host to bind (default: 127.0.0.1)",
    "  --port <port>          Port to bind (default: 3456)",
    "  --root-dir <path>      Runtime data directory (default: .artifact-agent)",
    "  --targets-dir <path>   Target profile directory (default: configs/targets)",
    "  --no-targets           Start without loading target profiles",
    "  --adapter <fake|real>  Adapter registry to use (default: fake)",
    "  --llm-config <path>    Optional LLM config path",
    "  --execute-inline       Execute accepted plans before validate_artifact returns",
    "  --demo-plan            Use a hand-written local demo plan",
    "  --log                  Enable Fastify logger",
    "  -h, --help             Show this help"
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    const options = parseRuntimeServerCliArgs(process.argv.slice(2));
    if (!isLocalHost(options.host)) {
      process.stderr.write("warning: Runtime HTTP API has no auth; prefer 127.0.0.1 unless this is an isolated test network\n");
    }
    const started = await startRuntimeServer(options);
    process.stdout.write(`Artifact Validation Runtime listening on ${started.address}\n`);
    process.stdout.write(`Runtime data root: ${path.resolve(process.cwd(), options.rootDir)}\n`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      await started.close();
      process.exit(0);
    };
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
  } catch (error) {
    if (error instanceof HelpRequestedError) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    process.stderr.write(`artifact-validation runtime failed: ${safeErrorMessage(error)}\n`);
    process.exit(1);
  }
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s"'`]+/gi, "$1[redacted]")
    .slice(0, 1000);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
