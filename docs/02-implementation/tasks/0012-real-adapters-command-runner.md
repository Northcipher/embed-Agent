## Task: real-adapters-command-runner

Goal:
提供真实 Tool Adapter 的安全执行骨架，让 Runtime 后续可以用已解析 target 配置调用 ADB、Fastboot 和 Serial 能力。

Non-goals:
- 不接真机自动发现。
- 不实现 target profile 文件加载。
- 不把 TUI / CLI / MCP 接到真实设备。
- 不允许 Plan 或 Observer 提供本机 shell 命令。
- 不实现独立连接池或后台 heartbeat 线程。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` section 6
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.12
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md` section 11
- `reference-repos/github/node-serialport/packages/serialport/package.json`
- `reference-repos/github/node-serialport/packages/repl/lib/index.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/adapters/adb_adapter.py`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/tests/test_serial_path_quoting.py`

Scope:
- `packages/adapters`
- lockfile if a dependency is added

Acceptance criteria:
- [x] AdbAdapter builds `adb -s <device_id>` argv commands without `shell=true`。
- [x] FlashAdapter builds fastboot argv commands or allowlisted custom command argv from adapter config only。
- [x] SerialAdapter reads serial output through an injectable reader and writes `serial.log` evidence。
- [x] Adapter outputs preserve stdout / stderr / exit code / timeout status as evidence。
- [x] Tests cover command argv construction, timeout handling, evidence writes, and unsafe input rejection。
- [x] No generic device execution or raw host shell adapter is introduced。

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
