# Task: runtime-state-machine

Goal:
实现 P0 Run State Machine 骨架，让 Runtime 能创建 run、校验状态转换、持久化 run state，并写入 `state_changed` 与终态事件。

Non-goals:
- 不执行 Plan step。
- 不实现 Tool Adapter。
- 不实现 Rule Engine / Observer。
- 不实现 HTTP / MCP / CLI / TUI。
- 不接真实设备或真实 LLM。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` section 2
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md` section 3.9 and 3.10
- `packages/file-store/src/store.ts`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/errors.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/response.py`

Scope:
- `packages/runtime-core`
- root TypeScript project references

Acceptance criteria:
- [x] Initial run creation only allows `queued` or `planning`.
- [x] All P0 allowed transitions are represented.
- [x] Terminal states cannot transition out.
- [x] Invalid transitions return `accepted=false` with `error_code=invalid_request`.
- [x] Valid transitions update `run.json` and append `state_changed`.
- [x] Transitions to `completed`, `failed`, and `cancelled` append terminal events.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
