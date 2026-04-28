## Task: mcp-thin-adapter

Goal:
提供 MCP stdio server，让 Coding Agent 通过稳定 MCP tools 调用 Runtime HTTP API。

Non-goals:
- 不实现 Runtime 状态管理。
- 不执行 adb / serial / fastboot / shell。
- 不暴露 `device_exec` 或通用 shell tool。
- 不实现 CLI / TUI。
- 不接 LLM Planner / Observer / Reply Generator。
- 不实现 MCP resources / prompts；P0 只暴露 tools。

References checked:
- `reference-repos/github/modelcontextprotocol-typescript-sdk/docs/server.md`
- `reference-repos/github/modelcontextprotocol-typescript-sdk/examples/server-quickstart/src/index.ts`
- `reference-repos/github/modelcontextprotocol-servers/src/filesystem/index.ts`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/server.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/response.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/errors.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/output_utils.py`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-REFERENCE-IMPLEMENTATIONS.md`
- `apps/runtime-server/src/server.ts`
- `packages/contracts/src/api.ts`

Scope:
- `apps/mcp-server`
- root TypeScript project references / lockfile

Acceptance criteria:
- [x] MCP server registers P0 tools: `validate_artifact`, `get_run_status`, `watch_run`, `get_run_events`, `get_evidence`, `get_run_result`, `intervene_run`, `cancel_run`, `get_target_capabilities`。
- [x] MCP server calls Runtime HTTP API only and does not own run / device state.
- [x] Tool inputs are validated with shared contract schemas.
- [x] Tool outputs include structured JSON content and `structuredContent`.
- [x] Runtime public errors are surfaced as MCP tool errors without throwing protocol errors.
- [x] Tests use a mocked Runtime HTTP endpoint/client, not a real device.
- [x] No generic `device_exec` or raw shell tool is exposed.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
