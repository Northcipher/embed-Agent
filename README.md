# Embed Agent

Automated embedded device validation. Flash firmware, watch serial output, detect issues, collect evidence.

## Quick Start

```bash
pnpm install
pnpm check    # typecheck + test
pnpm build    # compile all packages
```

## Packages

| Package | Description |
|---------|-------------|
| contracts | Type definitions, Zod schemas, error codes |
| stores | Event, Evidence, Run, Target, Memory, Skill, Task stores |
| tools | Connections (Serial, ADB, Fastboot, Local), RuleDetector, Aggregator, OutputPipe |
| runtime | EventBus, StepQueue, StepExecutor, DecisionHandler, RunManager, HookManager |
| agent | Planner, Observer, ReplyGenerator, Memory, SkillRegistry, LLMCallManager |
| notify | NotificationFilter for Slack/Email |
| views | Run, Target, Evidence read-only projections |

## Apps

| App | Description |
|-----|-------------|
| CLI | Command-line interface |
| MCP Server | Model Context Protocol server (9 tools) |
| TUI | Terminal dashboard |

## Docs

See `docs/01-foundation/` for architecture and requirements.
