## Task: run-status-current-step

Goal:
让 `get_run_status` 从事件流推导 `phase` 和 `current_step`，稳定回答 run 当前执行到哪一步。

Non-goals:
- 不实现持久化 step cursor。
- 不实现暂停后从 step 中间恢复。
- 不修改 Plan Executor 的执行顺序。
- 不改 TUI 视图。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FUNCTION-LIST.md`
- `packages/contracts/src/api.ts`
- `packages/runtime-core/src/plan-executor.ts`
- `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp/server.py`
- `reference-repos/github/modelcontextprotocol-servers/src/everything/tools/trigger-long-running-operation.ts`

Scope:
- `apps/runtime-server`
- `docs/02-implementation/tasks`

Acceptance criteria:
- [x] Running run status includes `phase=<capability>` and `current_step`.
- [x] `current_step` uses the latest active `step_started` event and exposes id, capability, started_at, timeout_sec.
- [x] Completed/failed/timed-out step events clear the active step.
- [x] Terminal run status omits `phase/current_step`.
- [x] Existing status response compatibility remains.

Verification:
- [x] `pnpm --filter @artifact-validation/runtime-server typecheck`
- [x] `pnpm --filter @artifact-validation/runtime-server test`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
