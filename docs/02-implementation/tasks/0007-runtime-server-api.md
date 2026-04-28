# Task: runtime-server-api

Goal:
提供本地 Runtime HTTP API，让 CLI / TUI / MCP 后续都能通过薄 adapter 查询和控制 Runtime。

Non-goals:
- 不实现 MCP server。
- 不实现 CLI / TUI。
- 不接真实设备 adapter。
- 不接 LLM Planner / Observer / Reply Generator。
- 不实现 target profile 文件管理；P0 capabilities 先由 Runtime Server 内置返回。
- 不新增通用 shell / device_exec HTTP 接口。

References checked:
- `reference-repos/github/fastify/docs/Reference/Routes.md`
- `reference-repos/github/fastify/docs/Reference/Validation-and-Serialization.md`
- `reference-repos/github/fastify/test/reply-code.test.js`
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-IMPLEMENTATION-STACK.md` section 8
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` sections 3.3, 3.4, 3.18
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/response.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/errors.py`

Scope:
- `apps/runtime-server`
- root TypeScript project references / lockfile

Acceptance criteria:
- [x] Fastify app exposes P0 local HTTP routes.
- [x] Route inputs are parsed through `packages/contracts` Zod schemas.
- [x] `POST /api/validate-artifact` creates a run and can execute a configured hand-written plan.
- [x] Status, events, evidence, result, cancel, intervene, and target capabilities endpoints return stable contract shapes.
- [x] Invalid input and missing run errors return public error structures.
- [x] Runtime Server remains a thin adapter over FileStore / RunManager / PlanExecutor.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
