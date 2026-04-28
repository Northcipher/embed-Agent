# Task: runtime-plan-executor

Goal:
让 Runtime Core 能执行一份手写 Plan，通过 fake adapters 跑完 Runtime-only 主链。

Non-goals:
- 不实现 Runtime HTTP API。
- 不实现 MCP / CLI / TUI。
- 不接 LLM Task Planner / Observer / Reply Generator。
- 不实现真实 ADB / fastboot / serial adapter。
- 不实现完整 Rule Engine。
- 不实现 paused run 的 step-cursor resume；P0 resume 由后续 `intervene_run` 切片处理，不能通过重跑整份 Plan 伪装。

References checked:
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-RUNTIME-CONTRACTS.md` sections 2 and 6
- `docs/01-foundation/ARTIFACT-VALIDATION-AGENT-FIRST-SLICE.md` sections 1, 4, 9, 10
- `docs/02-implementation/IMPLEMENTATION-WORKFLOW.md` sections 1, 2, 9, 10
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/response.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/errors.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/handlers/__init__.py`
- `$EMBEDCLAW_MCP_REFERENCE/embedclaw_mcp/handlers/device/exec.py`

Scope:
- `packages/runtime-core`
- root TypeScript project references / lockfile if needed

Acceptance criteria:
- [x] Plan executor validates Plan shape and adapter coverage before execution.
- [x] Missing capability rejects the Plan and marks an existing planning run failed.
- [x] Hand-written Plan can run through fake `flash -> watch_serial -> wait_adb -> shell_exec`.
- [x] Step execution writes `step_started`, `step_completed` / `step_failed` / `step_timeout`, and `evidence_collected` events.
- [x] Failure path can execute `on_failure` collection steps and end run as failed.
- [x] `fail` 和 `collect_and_fail` failure policy 行为不同：前者立即停，后者允许失败采集。
- [x] `continue` failure policy 会继续后续主路径，但不会执行 `on_success` 收尾。
- [x] Executor 层有 step timeout 兜底，不完全信任 adapter 自己处理 timeout。
- [x] Duplicate step id 会被 Plan validation 拒绝。
- [x] Paused run 不会被 `executePlan` 从头重跑。
- [x] Successful path transitions to `collecting_evidence` then `completed`.

Verification:
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`

Owner:
Codex

Reviewer:
Claude Code
