import type { CommandHandler } from "./command-handler.js";

type OutputFormat = "text" | "json";

function print(out: unknown, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify(out) + "\n");
  } else if (typeof out === "string") {
    process.stdout.write(out + "\n");
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  }
}

function parseArgs(argv: string[]): {
  command: string;
  args: Record<string, string | boolean>;
  format: OutputFormat;
} {
  const positional: string[] = [];
  const args: Record<string, string | boolean> = {};
  let format: OutputFormat = "text";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") { format = "json"; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  return { command: positional[0] ?? "help", args, format };
}

export async function runCli(handler: CommandHandler, argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, args, format } = parseArgs(argv);

  try {
    switch (command) {
      case "validate": {
        const req = {
          artifact: { path: args.artifact as string, type: args.type as string, version: args.version as string | undefined, build_id: args["build-id"] as string | undefined },
          target: args.target as string,
          expected: args.expected as string,
        } as Parameters<typeof handler.validate>[0];
        if (args.concerns) req.concerns = (args.concerns as string).split(",");
        if (args["success-criteria"]) req.success_criteria = (args["success-criteria"] as string).split(",");
        if (args["failure-criteria"]) req.failure_criteria = (args["failure-criteria"] as string).split(",");
        if (args["test-hint"]) req.test_hint = { kind: "adb_shell", command: args["test-hint"] as string };
        const constraints: Record<string, unknown> = {};
        if (args["max-duration"]) constraints.max_duration_sec = Number(args["max-duration"]);
        if (args["allow-flash"] !== undefined) constraints.allow_flash = args["allow-flash"] === "true";
        if (args["allow-shell-exec"] !== undefined) constraints.allow_shell_exec = args["allow-shell-exec"] === "true";
        if (args["no-flash"] !== undefined) constraints.no_flash = true;
        if (Object.keys(constraints).length > 0) req.constraints = constraints as any;
        const result = await handler.validate(req);
        print(result, format);
        break;
      }

      case "status": {
        const result = await handler.status(args["run-id"] as string);
        if (!result) { print({ status: "error", error_code: "run_not_found", message: "Run not found" }, format); break; }
        print(result, format);
        break;
      }

      case "events": {
        const result = await handler.events(
          args["run-id"] as string,
          args["after"] ? Number(args["after"]) : 0,
          args["limit"] ? Number(args["limit"]) : 100,
          args["types"] ? (args["types"] as string).split(",") : undefined,
        );
        print(result, format);
        break;
      }

      case "watch": {
        const runId = args["run-id"] as string;
        const after = args["after"] ? Number(args["after"]) : 0;
        const waitSec = args["wait"] ? Number(args["wait"]) : 30;
        const deadline = Date.now() + waitSec * 1000;
        let cursor = after;
        while (Date.now() < deadline) {
          const result = await handler.events(runId, cursor, 100);
          for (const e of result.events) {
            print(`${e.time} [${e.type}] ${e.summary}`, format);
          }
          cursor = result.next_after_seq;
          if (!result.has_more) await new Promise(r => setTimeout(r, 1000));
        }
        break;
      }

      case "result": {
        const result = await handler.result(args["run-id"] as string);
        print(result, format);
        break;
      }

      case "evidence": {
        const result = await handler.evidence(args["run-id"] as string, args["ref"] as string | undefined);
        print(result, format);
        break;
      }

      case "pause": {
        const result = await handler.pause(args["run-id"] as string, args["reason"] as string ?? "manual");
        print(result, format);
        break;
      }

      case "resume": {
        const result = await handler.resume(args["run-id"] as string);
        print(result, format);
        break;
      }

      case "cancel": {
        const result = await handler.cancel(args["run-id"] as string, args["reason"] as string ?? "manual");
        print(result, format);
        break;
      }

      case "intervene": {
        const runId = args["run-id"] as string;
        if (args["action"] === "add_instruction") {
          print(await handler.addInstruction(runId, args["instruction"] as string), format);
        } else if (args["action"] === "ignore_rule") {
          print(await handler.ignoreRule(runId, args["rule-id"] as string), format);
        } else if (args["action"] === "override") {
          print(await handler.override(runId, (args["decision"] ?? "continue") as "continue" | "stop" | "cancel", args["reason"] as string), format);
        } else {
          print({ status: "error", error_code: "invalid_request", message: `Unknown intervene action: ${args["action"]}` }, format);
        }
        break;
      }

      case "targets": {
        print(await handler.targetList(), format);
        break;
      }

      case "target": {
        if (args["show"]) {
          print(await handler.getTargetCapabilities(args["show"] as string), format);
        } else {
          print(await handler.targetList(), format);
        }
        break;
      }

      case "history": {
        print(await handler.history(args["target"] as string, args["limit"] ? Number(args["limit"]) : 10), format);
        break;
      }

      case "task": {
        if (args["list"] !== undefined) {
          print(await handler.taskList(), format);
        } else if (args["show"]) {
          print(await handler.taskShow(args["show"] as string), format);
        } else {
          print({ status: "error", error_code: "invalid_request", message: "Usage: embedagent task --list | --show <name>" }, format);
        }
        break;
      }

      case "memory": {
        if (args["add"]) {
          print(await handler.memoryAdd(args["target"] as string, args["category"] as string, args["add"] as string), format);
        } else if (args["ls"] !== undefined || args["list"] !== undefined) {
          print(await handler.memoryList(args["target"] as string, args["category"] as string), format);
        } else if (args["confirm"]) {
          print(await handler.memoryConfirm(args["confirm"] as string), format);
        } else if (args["delete"]) {
          print(await handler.memoryDelete(args["delete"] as string), format);
        } else {
          print({ status: "error", error_code: "invalid_request", message: "Usage: embedagent memory --add <statement> --target <id> --category <cat> | --ls [--target <id>] | --confirm <id> | --delete <id>" }, format);
        }
        break;
      }

      case "skill": {
        if (args["list"] !== undefined) {
          print(await handler.skillList(), format);
        } else if (args["show"]) {
          print(await handler.skillShow(args["show"] as string), format);
        } else {
          print({ status: "error", error_code: "invalid_request", message: "Usage: embedagent skill --list | --show <name>" }, format);
        }
        break;
      }

      case "hook": {
        if (args["list"] !== undefined) {
          print(await handler.hookList(), format);
        } else if (args["show"]) {
          print(await handler.hookShow(args["show"] as string), format);
        } else {
          print({ status: "error", error_code: "invalid_request", message: "Usage: embedagent hook --list | --show <name>" }, format);
        }
        break;
      }

      default:
        print(`embedagent — Embedded Device Validation Agent CLI

GLOBAL FLAGS

  --server <url>              Runtime HTTP URL (default: http://127.0.0.1:8787)
  --local-runtime             Development only: run an embedded Runtime in this CLI process

COMMANDS

  validate   Start a validation run on a target device.
             --artifact <path>            Path to firmware/APK/binary file (required)
             --type <type>                Artifact type: firmware, apk, binary, config (required)
             --target <id>                Target device ID (required)
             --expected <desc>            What should happen, e.g. "Device boots to shell" (required)
             --version <str>              Artifact version string
             --build-id <str>             Build identifier
             --concerns <a,b,c>           Comma-separated list of specific concerns to watch for
             --success-criteria <a,b,c>   Comma-separated explicit pass conditions
             --failure-criteria <a,b,c>   Comma-separated known failure signals
             --test-hint <cmd>            Shell command to use as a test hint, e.g. "ping -c1 8.8.8.8"
             --max-duration <sec>         Maximum run duration in seconds
             --allow-flash true|false     Allow flashing the device (default: true)
             --allow-shell-exec true|false Allow shell commands on device (default: true)
             --no-flash                   Forbid flashing entirely
             Example:
               embedagent validate --artifact fw.bin --type firmware --target esp32 \\
                 --expected "Device boots and responds to ping" --max-duration 120 --allow-flash false

  status     Get current state, progress, and step info for a run.
             --run-id <id>               Run ID (required)

  events     List events for a run, with optional pagination and type filtering.
             --run-id <id>               Run ID (required)
             --after <seq>               Only return events after this sequence number (default: 0)
             --limit <n>                 Max events to return (default: 100)
             --types <a,b,c>             Comma-separated event types to filter (e.g. "step_started,decision_made")

  watch      Watch a run for new events. Polls until new events arrive or timeout.
             --run-id <id>               Run ID (required)
             --after <seq>               Start watching after this sequence number (default: 0)
             --wait <sec>                Max seconds to wait for new events (default: 30)

  result     Get the final evaluation result for a completed run.
             --run-id <id>               Run ID (required)

  evidence   Get evidence from a run. Without --ref, returns the evidence index.
             --run-id <id>               Run ID (required)
             --ref <ref>                 Specific evidence reference, e.g. "serial:last-window"

  pause      Pause a running validation. The run can be resumed later.
             --run-id <id>               Run ID (required)
             --reason <text>             Why the run is being paused

  resume     Resume a paused validation run.
             --run-id <id>               Run ID (required)

  cancel     Cancel a running or paused validation.
             --run-id <id>               Run ID (required)
             --reason <text>             Why the run is being cancelled

  intervene  Intervene in a running validation with a specific action.
             --run-id <id>               Run ID (required)
             --action <action>           One of: pause, resume, cancel, add_instruction, ignore_rule, override
             --reason <text>             Why this intervention is needed
             --instruction <text>        Instruction text (for add_instruction action)
             --rule-id <id>              Rule ID to ignore (for ignore_rule action)
             --decision <c>              Override decision: continue, stop, cancel (for override action)

  targets    List all configured target devices with their current state and active runs.

  target     Get detailed capabilities and state for a specific target.
             --show <id>                 Target device ID (required)

  history    Get recent validation history for a target device.
             --target <id>               Target device ID (required)
             --limit <n>                 Max episodes to return (default: 10)

  task       Manage scheduled validation tasks.
             --list                      List all configured tasks
             --show <name>               Show details for a specific task

  memory     Manage persistent memory (known facts, issues) for a target device.
             --add <statement>           Add a new fact (use with --target and --category)
             --target <id>               Target device ID (for --add, --ls)
             --category <cat>            Fact category, e.g. "known_issue", "quirk", "pattern"
             --ls                        List facts (optionally filtered by --target and --category)
             --confirm <id>              Mark a fact as verified
             --delete <id>               Delete a fact by its fact_id

  skill      List and inspect reusable validation skill patterns.
             --list                      List all available skills
             --show <name>               Show details for a specific skill

  hook       List and inspect lifecycle hook scripts.
             --list                      List all configured hooks
             --show <name>               Show details for a specific hook

GLOBAL OPTIONS
  --json                               Output results as JSON instead of human-readable text

ENVIRONMENT
  EMBED_AGENT_SERVER_URL=http://...    Default HTTP Runtime URL (overridden by --server)
  EMBED_AGENT_CLI_MODE=local           Equivalent to --local-runtime`, format);
        break;
    }
  } catch (e) {
    print({ status: "error", error_code: "internal_error", message: (e as Error).message }, format);
  }
}
