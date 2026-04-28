# Task: fake-adapters

Goal:
提供 P0 capability adapter 接口和 fake adapter，让 Runtime-only 流程能在无真机、无 ADB、无 serial、无 fastboot 环境下跑通。

Non-goals:
- 不实现真实 ADB / fastboot / serial adapter。
- 不执行任何本机 shell 命令。
- 不读取 Target Profile 连接参数。
- 不实现 Orchestrator Plan 执行循环。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.12
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` sections 6.3 to 6.5
- `reference-repos/github/node-serialport/packages/parser-readline/lib/index.ts`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/adapters/adb_adapter.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/serial_client.py`

Scope:
- `packages/adapters`
- root TypeScript project references

Acceptance criteria:
- [x] A generic `CapabilityAdapter` interface exists.
- [x] Fake adapter supports all P0 capabilities.
- [x] `watch_serial`, `flash`, `shell_exec`, `collect_logs`, and `save_snapshot` write evidence refs through FileStore.
- [x] Fake adapter does not execute real shell / ADB / fastboot / serial.
- [x] Tests cover success and failure paths.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
