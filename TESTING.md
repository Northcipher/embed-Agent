# Embed Agent — Testing Manual

For the next AI or human pulling this repo for the first time.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥ 22 | `node -v` |
| pnpm | ≥ 9 | `pnpm -v` |
| Git | any | `git --version` |

**Windows extra**: install Git Bash or use PowerShell. All commands below work in both.

## Setup

```bash
git clone <this-repo>
cd embed-Agent
pnpm install
```

## Quick Verification

This should pass immediately — no API key, no hardware, no config needed:

```bash
pnpm check
```

Expect: `Test Files 30 passed | Tests 207 passed | 2 skipped`. Typecheck clean.

If this fails, stop. Something is wrong with the environment.

## Configuration

Create `.embed-agent/` at the repo root if it doesn't exist:

### `.embed-agent/system.yml`
```yaml
runtime:
  retry:
    max_retries: 2
    intervals_sec: [1, 3]
    retryable: ["timeout", "connection"]
  rule_policy:
    fatal_patterns: ["Kernel panic", "Watchdog reset", "Fatal exception"]
    warning_patterns: ["Out of memory", "slow", "timeout"]
    silence_timeout_sec: 30
  ring_buffer:
    max_lines: 500
    default_before: 200
    default_after: 80
  step_executor:
    max_timeout_sec: 3600
    default_timeout_sec: 60
storage:
  data_root: .embed-agent
  max_evidence_bytes: 104857600
  cleanup:
    keep_completed_days: 30
    keep_failed_days: 90
    max_episodes_per_target: 100
notifications:
  enabled: false
security:
  allowed_shell_commands: ["echo", "uname", "dmesg", "cat", "true", "false"]
  max_command_length: 4096
  block_unsafe_patterns: true
observer:
  debounce_sec: 30
  max_concurrent_per_run: 1
  default_checkpoint_interval_sec: 300
  circuit_breaker:
    max_failures: 3
    probe_after_sec: 300
  warning_escalation:
    threshold: 5
    window_sec: 300
prompt_version: "1"
```

### `.embed-agent/llm.yml`

**Without API key (MockProvider)**: minimal — works for tests, no real LLM calls.

```yaml
default_provider: mock
providers:
  mock:
    type: mock
    api_key_env: NONE
    models:
      planner: mock
      observer: mock
      reply: mock
```

**With DeepSeek** (if you have a key):

```yaml
default_provider: deepseek
providers:
  deepseek:
    type: anthropic
    api_key_env: ANTHROPIC_AUTH_TOKEN
    base_url: https://api.deepseek.com/anthropic
    models:
      planner: deepseek-v4-pro[1m]
      observer: deepseek-v4-flash[1m]
      reply: deepseek-v4-flash[1m]
    timeout:
      planner: 120
      observer: 60
      reply: 60
```

**With OpenAI**:

```yaml
default_provider: openai
providers:
  openai:
    type: openai
    api_key_env: OPENAI_API_KEY
    models:
      planner: gpt-4.1
      observer: gpt-4.1-mini
      reply: gpt-4.1
```

### `.embed-agent/targets.yml`

```yaml
demo:
  target_id: demo
  connections:
    local: available
  target_hints: {}
```

Without a real device, use `local` transport — it runs commands on the host machine (safe, no hardware needed).

## Run the System

### 1. CLI

```bash
# Build first
pnpm build

# List targets
node apps/cli/dist/main.js targets

# Create a validation run (local transport, no real device needed)
node apps/cli/dist/main.js validate \
  --artifact /tmp/test.img --type firmware \
  --expected "device boots" --target demo

# Watch events (replace <run-id>)
node apps/cli/dist/main.js events <run-id>

# Read result
node apps/cli/dist/main.js result <run-id>
```

### 2. MCP Server

Connect Claude Code or any MCP client:

```bash
# Start the MCP server (stdio)
node apps/mcp-server/dist/main.js
```

To connect Claude Code:
```bash
claude mcp add embed-agent -e ANTHROPIC_AUTH_TOKEN=<your-key> -- node apps/mcp-server/dist/main.js
```

10 tools available: `list_targets`, `get_target_capabilities`, `validate_artifact`, `get_run_status`, `watch_run`, `get_run_events`, `get_evidence`, `get_run_result`, `intervene_run`, `cancel_run`.

### 3. HTTP Server

```bash
node apps/http-server/dist/main.js
# Listening on http://127.0.0.1:8787
```

```bash
# Create a run
curl -X POST http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{"artifact":{"path":"/tmp/test.img","type":"firmware"},"target":"demo","expected":"device boots"}'

# Stream events (SSE)
curl -N http://127.0.0.1:8787/runs/<run-id>/events/stream

# Get result
curl http://127.0.0.1:8787/runs/<run-id>/result
```

### 4. TUI

```bash
node apps/tui/dist/main.js
```

Keys: `↑↓` navigate, `Enter` view run, `s` start run, `p` pause, `x` resume, `c` cancel, `r` result, `e` evidence, `h` help, `q` quit.

## Architecture

```
Agent (Plan / Observe / Reply)
  └── LLMCallManager → AIAnthropic / AIOpenAI / AIOpenAICompatible / MockProvider
        └── AI SDK (generateText)

Runtime (RunManager / StepExecutor / DecisionHandler / ContextAssembler)
  └── EventBus → EventStore / EvidenceStore

Tools (Serial / ADB / SSH / Fastboot / Local)
  └── ConnectionManager → Connection interface
        └── OutputPipe → RingBuffer → RuleDetector → Aggregator

Apps (CLI / MCP / HTTP / TUI)
  └── CommandHandler → RunManager + Views
```

## Test Layers

| Layer | Test Files | Tests | Framework |
|-------|-----------|-------|-----------|
| Agent | 3 files | 13 tests | MockProvider |
| Runtime | ~5 files | 43 tests | Mock + FakeConnection |
| Stores | ~6 files | 56 tests | File system |
| Tools | ~5 files | 37 tests | FakeClient / SerialPortMock |
| E2E | 1 file | 1 test | MockProvider + FakeConnection |
| HTTP Server | 1 file | 9 tests | inject + real fetch |
| TUI | 1 file | 5 tests | PassThrough stream |
| AI SDK | 1 file | 4 tests | Real DeepSeek API |

To run a specific test file:
```bash
npx vitest run packages/tools/test/adb.test.ts
npx vitest run apps/cli/test/e2e-full-flow.test.ts
npx vitest run packages/agent/test/all-agents-real.test.ts  # needs API key
```

## What Runs Without Hardware

Everything. All device connections have injectable fakes:
- `FakeAdbClient` — pre-scripted ADB responses
- `FakeSshClient` — mock shell output
- `SerialPortMock` — serialport's built-in mock binding
- `FakeConnection` — generic fake for E2E
- `MockProvider` — pre-set LLM responses

## Windows-Specific Notes

- **Path separators**: use `/` in configs. Node handles both on Windows.
- **ADB**: install Android SDK Platform Tools, add `adb.exe` to PATH.
- **Fastboot**: same as ADB — Platform Tools.
- **SSH**: install OpenSSH Client (Windows 10+ has it built-in via Settings → Apps → Optional Features).
- **Serial**: serialport uses native bindings. If `pnpm install` fails, install Visual C++ Build Tools.
- **Bash commands**: `curl` works in PowerShell. For the TUI, use Windows Terminal (not cmd.exe).
- **Line endings**: `.gitattributes` not configured. Use `git config core.autocrlf true` on Windows.

## Common Issues

1. **`pnpm install` fails on serialport**: install `windows-build-tools` or Visual C++ Build Tools.
2. **CB4 trips on first call**: LLM endpoint unreachable or API key wrong. Check `llm.yml`.
3. **`target_busy` on second run**: previous run still holding the lock. Wait 5s and retry.
4. **SSE stream hangs**: the `connected` event is sent immediately. If you get 0 events, increase `after_seq` poll interval or check run hasn't started yet.
5. **TUI shows "No targets"**: `targets.yml` not found or empty. Add at least one target.

## Running with a Real Device

1. Connect device via USB
2. Verify with `adb devices` or check serial port
3. Update `targets.yml`:
```yaml
esp32:
  target_id: esp32
  connections:
    serial: connected
    adb: online
  target_hints: {}
```
4. Update `security.allowed_shell_commands` if using real commands
5. Run validation through any entry point
