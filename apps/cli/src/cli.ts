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
        const concernsVal = typeof args.concerns === "string" ? args.concerns.split(",") : undefined;
        const req = {
          artifact: { path: args.artifact as string, type: args.type as string },
          target: args.target as string,
          expected: args.expected as string,
        } as Parameters<typeof handler.validate>[0];
        if (concernsVal) req.concerns = concernsVal;
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

      default:
        print(`Usage: embedagent <command> [options]

Commands:
  validate     --artifact <path> --type <type> --target <id> --expected <desc>
  status       --run-id <id>
  events       --run-id <id> [--after <seq>] [--limit <n>] [--types <list>]
  watch        --run-id <id> [--after <seq>] [--wait <sec>]
  result       --run-id <id>
  evidence     --run-id <id> [--ref <ref>]
  pause        --run-id <id> [--reason <text>]
  resume       --run-id <id>
  cancel       --run-id <id> [--reason <text>]
  intervene    --run-id <id> --action <action> [--instruction <text>] [--rule-id <id>] [--decision <c>]
  targets
  target       --show <id>
  history      --target <id> [--limit <n>]

Options: --json   Output as JSON`, format);
        break;
    }
  } catch (e) {
    print({ status: "error", error_code: "internal_error", message: (e as Error).message }, format);
  }
}
