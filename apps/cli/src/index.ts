#!/usr/bin/env node
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i]?.startsWith("--")) {
      const key = argv[i]!.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) { args[key] = val; i++; }
      else { args[key] = "true"; }
    }
  }
  return args;
}

function usage(): void {
  console.log(`Embed Agent CLI
  validate --artifact <path> --target <id> --expected <string>
  status --run-id <id>    result --run-id <id>
  pause --run-id <id>      resume --run-id <id>      cancel --run-id <id>`);
}

const cmd = process.argv[2];
const args = parseArgs(process.argv);
switch (cmd) {
  case "validate": console.log("validate:", JSON.stringify(args)); break;
  case "status": case "result": case "pause": case "resume": case "cancel":
    console.log(`${cmd}: ${args["run-id"] ?? "missing --run-id"}`); break;
  default: usage();
}
