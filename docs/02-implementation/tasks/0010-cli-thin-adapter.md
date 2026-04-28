## Task: cli-thin-adapter

Goal:
提供 Human / CI 可用的 TypeScript CLI wrapper，按 MCP 同语义调用 Runtime HTTP API。

Non-goals:
- 不实现 TUI / Console。
- 不保存 run / target 状态。
- 不读取 `.artifact-agent` 文件。
- 不执行 adb / serial / fastboot / shell。
- 不暴露 `device_exec` 或通用 shell 命令。

References checked:
- Commander.js official README: `https://raw.githubusercontent.com/tj/commander.js/master/Readme.md`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-ARCHITECTURE.md` section 12.2
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.21 / 6
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md` sections 8 / 10
- `packages/runtime-client/src/index.ts`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/cli.py`

Scope:
- `apps/cli`
- root TypeScript project references / lockfile

Acceptance criteria:
- [x] CLI exposes thin wrapper commands for validate, status, watch, events, evidence, result, cancel, pause, resume, intervene, and capabilities。
- [x] CLI uses `@artifact-validation/runtime-client` only; no direct Runtime Core / File Store / Adapter imports。
- [x] CLI validates validate input JSON with shared contract schema before calling Runtime。
- [x] CLI emits structured JSON to stdout for success and stderr for Runtime public errors。
- [x] CLI sets non-zero exit code for Runtime public errors and invalid input。
- [x] Tests use a mocked Runtime client and fake file reader, not a real Runtime Server or device。
- [x] No generic `device_exec` or raw shell command is exposed。

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
